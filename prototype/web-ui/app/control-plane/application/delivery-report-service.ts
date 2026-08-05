import {
  deliveryReportSchemaVersion,
  type DeliveryHumanAcceptance,
  type DeliveryKnownRisk,
  type DeliveryReport,
} from "../domain/delivery-report.ts";
import { canonicalJson, sha256Hex } from "../domain/spec-artifact.ts";
import type { DeliveryReportSourcePort } from
  "../ports/delivery-report-source-port.ts";
import type {
  GoalVerificationRepository,
  GoalVerificationScope,
} from "../ports/goal-verification-repository.ts";

export interface DeliveryReportAuthorizer {
  authorize(input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    permission: "delivery_report.generate" | "delivery_report.read" | "goal.accept";
  }): Promise<void>;
}

function bounded(value: string, name: string, maximum = 4_000): string {
  if (typeof value !== "string" || !value.trim() ||
    value.trim().length > maximum) {
    throw new Error(`${name} must be non-blank and bounded`);
  }
  return value.trim();
}

function validateRisks(risks: readonly DeliveryKnownRisk[]): DeliveryKnownRisk[] {
  if (!Array.isArray(risks) || risks.length > 100) {
    throw new Error("knownRisks must be a bounded list");
  }
  return risks.map((risk, index) => {
    if (!["low", "medium", "high", "critical"].includes(risk.severity) ||
      !["accepted", "monitor", "blocked"].includes(risk.disposition)) {
      throw new Error(`knownRisks[${index}] is invalid`);
    }
    return {
      severity: risk.severity,
      statement: bounded(risk.statement, `knownRisks[${index}].statement`),
      disposition: risk.disposition,
    };
  });
}

async function withDigest(
  value: Omit<DeliveryReport, "digest">,
): Promise<DeliveryReport> {
  return {
    ...value,
    digest: await sha256Hex(canonicalJson(value)),
  };
}

function withoutDigest(
  report: DeliveryReport,
): Omit<DeliveryReport, "digest"> {
  const payload: Partial<DeliveryReport> = { ...report };
  delete payload.digest;
  return payload as Omit<DeliveryReport, "digest">;
}

export class DeliveryReportService {
  private readonly repository: GoalVerificationRepository;
  private readonly source: DeliveryReportSourcePort;
  private readonly authorizer: DeliveryReportAuthorizer;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(input: {
    repository: GoalVerificationRepository;
    source: DeliveryReportSourcePort;
    authorizer: DeliveryReportAuthorizer;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.repository = input.repository;
    this.source = input.source;
    this.authorizer = input.authorizer;
    this.clock = input.clock ?? (() => new Date());
    this.idGenerator = input.idGenerator ?? (() => crypto.randomUUID());
  }

  async generate(command: GoalVerificationScope & {
    verificationId: string;
    actorId: string;
    knownRisks: readonly DeliveryKnownRisk[];
  }): Promise<DeliveryReport> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "delivery_report.generate",
    });
    const scope = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
    };
    const [verification, verifications, source, reports, plans] = await Promise.all([
      this.repository.getVerification(command),
      this.repository.listVerifications(scope),
      this.source.collect(scope),
      this.repository.listDeliveryReports(scope),
      this.repository.listPlans(scope),
    ]);
    if (!verification || verifications.at(-1)?.id !== verification.id ||
      verification.verdict !== "passed" ||
      verification.verifierOutput.overallVerdict !== "passed") {
      throw new Error("A passed Goal verification is required for Delivery Report");
    }
    const plan = await this.repository.getPlan({
      ...scope,
      planId: verification.verificationPlanId,
    });
    if (!plan || plans.at(-1)?.id !== plan.id ||
      plan.issuePlanId !== verification.issuePlanId ||
      source.goal.id !== command.goalId || source.goal.status !== "verifying" ||
      source.goal.version !== verification.goalVersion) {
      throw new Error("Delivery Report source or verification plan is stale");
    }
    await this.repository.synchronizeGoal(source.goal);
    const criterionById = new Map(
      source.goal.acceptanceCriteria.map((criterion) => [criterion.id, criterion]),
    );
    const acceptance = verification.verifierOutput.criteria.map((result) => {
      const criterion = criterionById.get(result.criterionRef);
      if (!criterion || result.verdict !== "passed" ||
        result.evidenceRefs.length === 0) {
        throw new Error("Every criterion requires a passed verdict and evidence");
      }
      return {
        criterionRef: result.criterionRef,
        statement: criterion.statement,
        verdict: "passed" as const,
        evidenceRefs: result.evidenceRefs,
        rationale: result.rationale,
      };
    });
    const availableArtifactRefs = new Set([
      ...source.issueRuns.flatMap(({ artifactRefs }) => artifactRefs),
      ...verification.deterministicResults.flatMap(({ evidenceRefs }) =>
        evidenceRefs
      ),
    ]);
    if (source.issueRuns.length === 0 ||
      source.issueRuns.some((run) =>
        run.status !== "completed" || run.artifactRefs.length === 0 ||
        run.reviewIds.length === 0 || !run.commitSha
      ) ||
      acceptance.some(({ evidenceRefs }) =>
        evidenceRefs.some((reference) => !availableArtifactRefs.has(reference))
      )) {
      throw new Error(
        "Completed Issue, immutable evidence, Review, and Commit references are required",
      );
    }
    const risks = validateRisks(command.knownRisks);
    if (risks.some(({ disposition }) => disposition === "blocked")) {
      throw new Error("Blocked risk prevents Delivery Report generation");
    }
    const latest = reports.at(-1);
    const generatedAt = this.clock().toISOString();
    const report = await withDigest({
      schemaVersion: deliveryReportSchemaVersion,
      id: this.idGenerator(),
      ...scope,
      revision: (latest?.revision ?? 0) + 1,
      previousReportId: latest?.id ?? null,
      verificationId: verification.id,
      verificationPlanId: plan.id,
      issuePlanId: verification.issuePlanId,
      goal: source.goal,
      acceptance,
      issueRuns: source.issueRuns,
      exceptions: source.exceptions,
      knownRisks: risks,
      regressionRisks: verification.verifierOutput.regressionRisks,
      status: "awaiting_human_acceptance",
      humanAcceptance: null,
      generatedBy: command.actorId,
      generatedAt,
      version: 1,
    });
    return await this.repository.appendDeliveryReport(report);
  }

  async accept(command: GoalVerificationScope & {
    reportId: string;
    actorId: string;
    expectedGoalVersion: number;
    reason: string;
    requestId: string;
    idempotencyKey: string;
  }): Promise<{ report: DeliveryReport; goal: DeliveryReport["goal"] }> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "goal.accept",
    });
    const reason = bounded(command.reason, "reason");
    const requestId = bounded(command.requestId, "requestId", 200);
    const idempotencyKey = bounded(command.idempotencyKey, "idempotencyKey", 200);
    if (idempotencyKey.length < 8) throw new Error("idempotencyKey is too short");
    const requestHash = await sha256Hex(canonicalJson({
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
      reportId: command.reportId,
      actorId: command.actorId,
      expectedGoalVersion: command.expectedGoalVersion,
      reason,
      requestId,
    }));
    const [current, reports, goal] = await Promise.all([
      this.repository.getDeliveryReport(command),
      this.repository.listDeliveryReports(command),
      this.repository.getGoal(command),
    ]);
    const latest = reports.at(-1);
    if (current && latest?.status === "accepted" &&
      latest.previousReportId === current.id) {
      return await this.repository.acceptDeliveryReport({
        current,
        accepted: latest,
        expectedGoalVersion: command.expectedGoalVersion,
        idempotencyKey,
        requestHash,
      });
    }
    if (!current || latest?.id !== current.id ||
      current.status !== "awaiting_human_acceptance" || !goal ||
      goal.status !== "verifying" || goal.version !== command.expectedGoalVersion ||
      current.knownRisks.some(({ disposition }) => disposition === "blocked")) {
      throw new Error("Delivery Report or Goal version conflict");
    }
    const acceptedAt = this.clock().toISOString();
    const humanAcceptance: DeliveryHumanAcceptance = {
      actorId: command.actorId,
      role: "approver",
      reason,
      requestId,
      acceptedAt,
    };
    const accepted = await withDigest({
      ...withoutDigest(current),
      id: this.idGenerator(),
      revision: current.revision + 1,
      previousReportId: current.id,
      status: "accepted",
      humanAcceptance,
      generatedBy: command.actorId,
      generatedAt: acceptedAt,
      version: 1,
    });
    return await this.repository.acceptDeliveryReport({
      current,
      accepted,
      expectedGoalVersion: command.expectedGoalVersion,
      idempotencyKey,
      requestHash,
    });
  }

  async export(command: GoalVerificationScope & {
    reportId: string;
    actorId: string;
  }): Promise<{ fileName: string; mediaType: "application/json"; body: string }> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "delivery_report.read",
    });
    const report = await this.repository.getDeliveryReport(command);
    if (!report) throw new Error("Delivery Report was not found");
    return {
      fileName: `delivery-report-${report.goalId}-r${report.revision}.json`,
      mediaType: "application/json",
      body: JSON.stringify(report, null, 2),
    };
  }

  async timeline(command: GoalVerificationScope & { actorId: string }) {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "delivery_report.read",
    });
    return await this.repository.listDeliveryReports(command);
  }
}
