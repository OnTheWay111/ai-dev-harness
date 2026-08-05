import { canonicalJson, sha256Hex } from "../domain/spec-artifact.ts";
import {
  verificationGapReportSchemaVersion,
  type GapRemediationReceipt,
  type VerificationGapReport,
} from "../domain/verification-gap.ts";
import type {
  GoalVerificationRepository,
  GoalVerificationScope,
} from "../ports/goal-verification-repository.ts";

export interface GapRemediationPort {
  createDraft(input: {
    scope: GoalVerificationScope;
    previousIssuePlanId: string;
    verificationId: string;
    gapReportId: string;
    actorId: string;
    reason: string;
    draft: unknown;
  }): Promise<GapRemediationReceipt["plan"]>;
}

export interface VerificationGapAuthorizer {
  authorize(input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    permission: "goal.verify" | "issue.generate";
  }): Promise<void>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function bounded(value: string, name: string, maximum = 4_000): string {
  if (typeof value !== "string" || !value.trim() ||
    value.trim().length > maximum) {
    throw new Error(`${name} must be non-blank and bounded`);
  }
  return value.trim();
}

export class VerificationGapService {
  private readonly repository: GoalVerificationRepository;
  private readonly remediation: GapRemediationPort;
  private readonly authorizer: VerificationGapAuthorizer;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(input: {
    repository: GoalVerificationRepository;
    remediation: GapRemediationPort;
    authorizer: VerificationGapAuthorizer;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.repository = input.repository;
    this.remediation = input.remediation;
    this.authorizer = input.authorizer;
    this.clock = input.clock ?? (() => new Date());
    this.idGenerator = input.idGenerator ?? (() => crypto.randomUUID());
  }

  async create(command: GoalVerificationScope & {
    verificationId: string;
    actorId: string;
  }): Promise<VerificationGapReport> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "goal.verify",
    });
    const existing = await this.repository.findGapReportByVerification(command);
    if (existing) return deepFreeze(existing);
    const [verification, timeline] = await Promise.all([
      this.repository.getVerification(command),
      this.repository.listVerifications(command),
    ]);
    if (!verification || timeline.at(-1)?.id !== verification.id ||
      verification.verdict === "passed") {
      throw new Error("Only the latest failed verification can create a gap report");
    }
    const deterministic = new Map(
      verification.deterministicResults.map((result) => [result.criterionRef, result]),
    );
    const criterionGaps = verification.verifierOutput.criteria
      .filter(({ verdict }) => verdict !== "passed")
      .map((criterion) => ({
      sourceKind: "acceptance_criterion" as const,
      sourceRef: criterion.criterionRef,
      criterionRef: criterion.criterionRef,
      currentEvidenceRefs: [...new Set([
        ...(deterministic.get(criterion.criterionRef)?.evidenceRefs ?? []),
        ...criterion.evidenceRefs,
      ])],
      gap: criterion.rationale,
      impact: verification.verifierOutput.regressionRisks
        .filter(({ evidenceRefs }) =>
          evidenceRefs.some((ref) => criterion.evidenceRefs.includes(ref))
        )
        .map(({ description }) => description)
        .join(" ") || "The original AcceptanceCriterion remains unproved.",
      suggestedRemediation:
        "Create a new Issue plan revision that closes this evidence gap, then re-run Compiler, approval, execution, and verification.",
    }));
    const boundaryGaps = [
      ...verification.verifierOutput.nonGoals
        .filter(({ verdict }) => verdict !== "preserved")
        .map((boundary) => ({
          sourceKind: "non_goal" as const,
          sourceRef: boundary.statement,
          criterionRef: null,
          currentEvidenceRefs: [] as string[],
          gap: boundary.rationale,
          impact: "The delivered scope may violate an explicit non-goal.",
          suggestedRemediation:
            "Create a new Issue plan revision that restores the non-goal boundary, then re-run Compiler, approval, execution, and verification.",
        })),
      ...verification.verifierOutput.constraints
        .filter(({ verdict }) => verdict !== "satisfied")
        .map((boundary) => ({
          sourceKind: "constraint" as const,
          sourceRef: boundary.statement,
          criterionRef: null,
          currentEvidenceRefs: [] as string[],
          gap: boundary.rationale,
          impact: "The delivered implementation may violate an explicit constraint.",
          suggestedRemediation:
            "Create a new Issue plan revision that satisfies the constraint, then re-run Compiler, approval, execution, and verification.",
        })),
    ];
    const gaps = [...criterionGaps, ...boundaryGaps];
    if (gaps.length === 0) {
      throw new Error("A failed verification must identify at least one criterion gap");
    }
    const report: VerificationGapReport = {
      schemaVersion: verificationGapReportSchemaVersion,
      id: this.idGenerator(),
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
      verificationId: verification.id,
      issuePlanId: verification.issuePlanId,
      failedCriterionRefs: gaps.flatMap(({ criterionRef }) =>
        criterionRef ? [criterionRef] : []
      ),
      preservedEvidenceRefs: [...new Set(
        verification.deterministicResults.flatMap(({ evidenceRefs }) => evidenceRefs),
      )].sort(),
      gaps,
      createdBy: command.actorId,
      createdAt: this.clock().toISOString(),
      version: 1,
    };
    return deepFreeze(await this.repository.appendGapReport(report));
  }

  async confirm(command: GoalVerificationScope & {
    reportId: string;
    actorId: string;
    humanConfirmed: boolean;
    reason: string;
    idempotencyKey: string;
    draft: unknown;
  }): Promise<GapRemediationReceipt> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "issue.generate",
    });
    if (command.humanConfirmed !== true) {
      throw new Error("Explicit human confirmation is required for remediation");
    }
    const reason = bounded(command.reason, "reason");
    const idempotencyKey = bounded(
      command.idempotencyKey,
      "idempotencyKey",
      200,
    );
    if (idempotencyKey.length < 8) throw new Error("idempotencyKey is too short");
    const report = await this.repository.getGapReport(command);
    if (!report) throw new Error("Verification gap report was not found");
    const requestHash = await sha256Hex(canonicalJson({
      reportId: report.id,
      actorId: command.actorId,
      reason,
      draft: command.draft,
    }));
    const replay = await this.repository.findGapRemediation({
      organizationId: command.organizationId,
      reportId: report.id,
      actorId: command.actorId,
      idempotencyKey,
    });
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new Error("Gap remediation idempotency conflict");
      }
      return replay.receipt;
    }
    const plan = await this.remediation.createDraft({
      scope: {
        organizationId: command.organizationId,
        projectId: command.projectId,
        goalId: command.goalId,
      },
      previousIssuePlanId: report.issuePlanId,
      verificationId: report.verificationId,
      gapReportId: report.id,
      actorId: command.actorId,
      reason,
      draft: command.draft,
    });
    if (plan.previousPlanId !== report.issuePlanId || plan.status !== "draft" ||
      plan.compilation.valid !== true) {
      throw new Error(
        "Gap remediation must create a compiled draft after the failed Issue plan",
      );
    }
    const receipt: GapRemediationReceipt = {
      reportId: report.id,
      plan,
      preservedEvidenceRefs: report.preservedEvidenceRefs,
      actorId: command.actorId,
      reason,
      recordedAt: this.clock().toISOString(),
    };
    return await this.repository.saveGapRemediation({
      organizationId: command.organizationId,
      reportId: report.id,
      actorId: command.actorId,
      idempotencyKey,
      requestHash,
      receipt,
    });
  }

  async timeline(command: GoalVerificationScope & { actorId: string }) {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "goal.verify",
    });
    return await this.repository.listGapReports(command);
  }
}
