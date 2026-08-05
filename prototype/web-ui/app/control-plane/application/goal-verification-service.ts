import type { GoalWorkspaceRepository } from
  "../ports/goal-workspace-repository.ts";
import type { GoalVerificationRepository } from
  "../ports/goal-verification-repository.ts";
import type {
  BuilderIdentitySourcePort,
  DeterministicVerifierPort,
  GoalVerifierPort,
} from "../ports/goal-verifier-port.ts";
import type { IssuePlanRepository } from
  "../ports/issue-plan-repository.ts";
import {
  GoalVerifierContractError,
  goalVerificationSchemaVersion,
  validateGoalVerifierOutput,
  type CriterionVerificationVerdict,
  type GoalVerification,
} from "../domain/goal-verification.ts";

export interface GoalVerificationAuthorizer {
  authorize(input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    permission: "goal.verify" | "goal.accept";
  }): Promise<void>;
}

async function within<T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new GoalVerifierContractError(message)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function derivedVerdict(
  deterministic: readonly { status: CriterionVerificationVerdict }[],
  output: ReturnType<typeof validateGoalVerifierOutput>,
): CriterionVerificationVerdict {
  if (deterministic.some(({ status }) => status === "failed") ||
    output.overallVerdict === "failed" ||
    output.criteria.some(({ verdict }) => verdict === "failed") ||
    output.nonGoals.some(({ verdict }) => verdict === "violated") ||
    output.constraints.some(({ verdict }) => verdict === "violated")) {
    return "failed";
  }
  if (deterministic.some(({ status }) => status === "needs_manual") ||
    output.overallVerdict === "needs_manual" ||
    output.criteria.some(({ verdict }) => verdict === "needs_manual") ||
    output.nonGoals.some(({ verdict }) => verdict === "unknown") ||
    output.constraints.some(({ verdict }) => verdict === "unknown")) {
    return "needs_manual";
  }
  return "passed";
}

export class GoalVerificationService {
  private readonly repository: GoalVerificationRepository;
  private readonly goals: Pick<GoalWorkspaceRepository, "get">;
  private readonly deterministicVerifier: DeterministicVerifierPort;
  private readonly verifier: GoalVerifierPort;
  private readonly issuePlans: Pick<IssuePlanRepository, "getLatest">;
  private readonly authorizer: GoalVerificationAuthorizer;
  private readonly builderIdentitySource: BuilderIdentitySourcePort;
  private readonly verifierIdentity: string;
  private readonly verifierVersion: string;
  private readonly verifierTimeoutMs: number;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(input: {
    repository: GoalVerificationRepository;
    goals: Pick<GoalWorkspaceRepository, "get">;
    deterministicVerifier: DeterministicVerifierPort;
    verifier: GoalVerifierPort;
    issuePlans: Pick<IssuePlanRepository, "getLatest">;
    authorizer: GoalVerificationAuthorizer;
    builderIdentitySource: BuilderIdentitySourcePort;
    verifierIdentity: string;
    verifierVersion: string;
    verifierTimeoutMs?: number;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.repository = input.repository;
    this.goals = input.goals;
    this.deterministicVerifier = input.deterministicVerifier;
    this.verifier = input.verifier;
    this.issuePlans = input.issuePlans;
    this.authorizer = input.authorizer;
    this.builderIdentitySource = input.builderIdentitySource;
    this.verifierIdentity = input.verifierIdentity.trim();
    this.verifierVersion = input.verifierVersion.trim();
    this.verifierTimeoutMs = input.verifierTimeoutMs ?? 120_000;
    this.clock = input.clock ?? (() => new Date());
    this.idGenerator = input.idGenerator ?? (() => crypto.randomUUID());
  }

  async verify(command: {
    organizationId: string;
    projectId: string;
    goalId: string;
    planId: string;
    actorId: string;
    expectedGoalVersion: number;
    manualEvidence?: readonly {
      entryId: string;
      evidenceRef: string;
      reason: string;
    }[];
  }): Promise<GoalVerification> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "goal.verify",
    });
    const scope = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
    };
    const [goal, plan, latestPlan, previous, latestIssuePlan] = await Promise.all([
      this.goals.get({ id: command.goalId, ...scope }),
      this.repository.getPlan({ ...scope, planId: command.planId }),
      this.repository.listPlans(scope),
      this.repository.listVerifications(scope),
      this.issuePlans.getLatest(scope),
    ]);
    if (!goal || !plan || goal.status !== "verifying" ||
      goal.version !== command.expectedGoalVersion ||
      plan.goalVersion !== goal.version || !plan.compilation.valid ||
      latestPlan.at(-1)?.id !== plan.id || latestIssuePlan?.id !== plan.issuePlanId ||
      latestIssuePlan.status !== "approved") {
      throw new GoalVerifierContractError(
        "Goal or compiled verification plan is stale or unavailable",
      );
    }
    const builders = await this.builderIdentitySource.list({
      ...scope,
      issuePlanId: plan.issuePlanId,
    });
    const allBuilders = [...new Set(builders)].filter(Boolean);
    if (!this.verifierIdentity || !this.verifierVersion ||
      allBuilders.some((identity) =>
        identity.trim().toLocaleLowerCase("en-US") ===
          this.verifierIdentity.toLocaleLowerCase("en-US")
      )) {
      throw new GoalVerifierContractError(
        "Goal Verifier identity must be independent from every Builder",
      );
    }
    const deterministicResults = [];
    const manualEvidence = new Map(
      (command.manualEvidence ?? []).map((evidence) => [evidence.entryId, evidence]),
    );
    if (manualEvidence.size !== (command.manualEvidence ?? []).length) {
      throw new GoalVerifierContractError("Manual evidence entry IDs must be unique");
    }
    for (const entry of plan.entries) {
      const started = Date.now();
      let result;
      if (entry.strategy.type === "manual") {
        const signed = manualEvidence.get(entry.id);
        if (signed) {
          await this.authorizer.authorize({
            actorId: command.actorId,
            organizationId: command.organizationId,
            projectId: command.projectId,
            permission: "goal.accept",
          });
          if (!signed.evidenceRef.trim() || !signed.reason.trim()) {
            throw new GoalVerifierContractError(
              `Manual verification ${entry.id} requires evidence and reason`,
            );
          }
          result = {
            status: "passed" as const,
            evidenceRefs: [signed.evidenceRef.trim()],
            summary: signed.reason.trim(),
            durationMs: 0,
            manualApproval: {
              actorId: command.actorId,
              role: "approver" as const,
              reason: signed.reason.trim(),
              signedAt: this.clock().toISOString(),
            },
          };
        } else {
          result = {
            status: "needs_manual" as const,
            evidenceRefs: [] as string[],
            summary: entry.strategy.instructions,
            durationMs: 0,
          };
        }
      } else {
        const controller = new AbortController();
        try {
          result = await within(
            this.deterministicVerifier.run(entry, scope, controller.signal),
            entry.timeoutMs,
            `Deterministic verification ${entry.id} timed out`,
          );
        } finally {
          controller.abort();
        }
      }
      if (!["passed", "failed", "needs_manual"].includes(result.status) ||
        !Array.isArray(result.evidenceRefs) || !result.summary.trim() ||
        (result.status === "passed" && result.evidenceRefs.length === 0)) {
        throw new GoalVerifierContractError(
          `Deterministic verification ${entry.id} returned invalid evidence`,
        );
      }
      deterministicResults.push({
        entryId: entry.id,
        criterionRef: entry.criterionRef,
        status: result.status,
        evidenceRefs: [...new Set(result.evidenceRefs)],
        summary: result.summary.trim(),
        durationMs: result.durationMs ?? Date.now() - started,
        ...(result.manualApproval
          ? { manualApproval: result.manualApproval }
          : {}),
      });
    }
    if ([...manualEvidence.keys()].some((entryId) =>
      !plan.entries.some((entry) =>
        entry.id === entryId && entry.strategy.type === "manual"
      )
    )) {
      throw new GoalVerifierContractError("Manual evidence references an unknown entry");
    }
    const sessionId = crypto.randomUUID();
    const rawOutput = await within(
      this.verifier.verify({
        goal,
        plan,
        deterministicResults,
        verifierIdentity: this.verifierIdentity,
        builderIdentities: allBuilders,
        session: {
          id: sessionId,
          fresh: true,
          access: "read_only",
          canModifyCode: false,
        },
      }),
      this.verifierTimeoutMs,
      "Goal Verifier session timed out",
    );
    const verifierOutput = validateGoalVerifierOutput(rawOutput, goal);
    const availableEvidence = new Set(
      deterministicResults.flatMap(({ evidenceRefs }) => evidenceRefs),
    );
    if (verifierOutput.criteria.some(({ evidenceRefs, verdict }) =>
      verdict === "passed" &&
      (evidenceRefs.length === 0 || evidenceRefs.some((ref) => !availableEvidence.has(ref)))
    )) {
      throw new GoalVerifierContractError(
        "Verifier cited missing evidence for a passed criterion",
      );
    }
    const latest = previous.at(-1);
    const verification: GoalVerification = {
      schemaVersion: goalVerificationSchemaVersion,
      id: this.idGenerator(),
      ...scope,
      verificationPlanId: plan.id,
      issuePlanId: plan.issuePlanId,
      revision: (latest?.revision ?? 0) + 1,
      previousVerificationId: latest?.id ?? null,
      goalVersion: goal.version,
      verdict: derivedVerdict(deterministicResults, verifierOutput),
      deterministicResults,
      verifierOutput,
      verifierIdentity: this.verifierIdentity,
      verifierVersion: this.verifierVersion,
      sessionId,
      verifiedAt: this.clock().toISOString(),
      version: 1,
    };
    return await this.repository.appendVerification(verification);
  }

  async timeline(command: {
    organizationId: string;
    projectId: string;
    goalId: string;
    actorId: string;
  }) {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "goal.verify",
    });
    return await this.repository.listVerifications(command);
  }
}
