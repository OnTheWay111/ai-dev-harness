import type { AcceptanceVerificationPlan } from
  "../domain/acceptance-verification.ts";
import type { DeliveryReport } from "../domain/delivery-report.ts";
import type { GoalContract } from "../domain/goal-contract.ts";
import type { GoalVerification } from "../domain/goal-verification.ts";
import type {
  GapRemediationReceipt,
  VerificationGapReport,
} from "../domain/verification-gap.ts";
import type {
  GoalVerificationRepository,
  GoalVerificationScope,
} from "../ports/goal-verification-repository.ts";

function scopeKey(scope: GoalVerificationScope): string {
  return `${scope.organizationId}/${scope.projectId}/${scope.goalId}`;
}

function scoped<T extends GoalVerificationScope>(
  values: Iterable<T>,
  scope: GoalVerificationScope,
): T[] {
  const key = scopeKey(scope);
  return [...values].filter((value) => scopeKey(value) === key);
}

export class MemoryGoalVerificationRepository
implements GoalVerificationRepository {
  private readonly plans = new Map<string, AcceptanceVerificationPlan>();
  private readonly verifications = new Map<string, GoalVerification>();
  private readonly gaps = new Map<string, VerificationGapReport>();
  private readonly remediations = new Map<string, {
    requestHash: string;
    receipt: GapRemediationReceipt;
  }>();
  private readonly reports = new Map<string, DeliveryReport>();
  private readonly goals = new Map<string, GoalContract>();
  private readonly acceptanceOperations = new Map<string, {
    requestHash: string;
    result: { report: DeliveryReport; goal: GoalContract };
  }>();

  constructor(input: {
    plans?: readonly AcceptanceVerificationPlan[];
    verifications?: readonly GoalVerification[];
    gaps?: readonly VerificationGapReport[];
    reports?: readonly DeliveryReport[];
    goals?: readonly GoalContract[];
  } = {}) {
    for (const value of input.plans ?? []) {
      this.plans.set(value.id, structuredClone(value));
    }
    for (const value of input.verifications ?? []) {
      this.verifications.set(value.id, structuredClone(value));
    }
    for (const value of input.gaps ?? []) {
      this.gaps.set(value.id, structuredClone(value));
    }
    for (const value of input.reports ?? []) {
      this.reports.set(value.id, structuredClone(value));
    }
    for (const value of input.goals ?? []) {
      this.goals.set(scopeKey({ ...value, goalId: value.id }), structuredClone(value));
    }
  }

  async appendPlan(
    plan: AcceptanceVerificationPlan,
  ): Promise<AcceptanceVerificationPlan> {
    if (this.plans.has(plan.id)) throw new Error("Verification plan already exists");
    const latest = (await this.listPlans(plan)).at(-1);
    if ((latest?.id ?? null) !== plan.previousPlanId ||
      plan.revision !== (latest?.revision ?? 0) + 1) {
      throw new Error("Verification plan revision conflict");
    }
    this.plans.set(plan.id, structuredClone(plan));
    return structuredClone(plan);
  }

  async getPlan(
    input: GoalVerificationScope & { planId: string },
  ): Promise<AcceptanceVerificationPlan | null> {
    const value = this.plans.get(input.planId);
    return value && scopeKey(value) === scopeKey(input)
      ? structuredClone(value)
      : null;
  }

  async listPlans(
    scope: GoalVerificationScope,
  ): Promise<readonly AcceptanceVerificationPlan[]> {
    return structuredClone(scoped(this.plans.values(), scope)
      .sort((left, right) => left.revision - right.revision));
  }

  async appendVerification(
    verification: GoalVerification,
  ): Promise<GoalVerification> {
    if (this.verifications.has(verification.id)) {
      throw new Error("Goal verification already exists");
    }
    const latest = (await this.listVerifications(verification)).at(-1);
    if ((latest?.id ?? null) !== verification.previousVerificationId ||
      verification.revision !== (latest?.revision ?? 0) + 1) {
      throw new Error("Goal verification revision conflict");
    }
    this.verifications.set(verification.id, structuredClone(verification));
    return structuredClone(verification);
  }

  async getVerification(
    input: GoalVerificationScope & { verificationId: string },
  ): Promise<GoalVerification | null> {
    const value = this.verifications.get(input.verificationId);
    return value && scopeKey(value) === scopeKey(input)
      ? structuredClone(value)
      : null;
  }

  async listVerifications(
    scope: GoalVerificationScope,
  ): Promise<readonly GoalVerification[]> {
    return structuredClone(scoped(this.verifications.values(), scope)
      .sort((left, right) => left.revision - right.revision));
  }

  async appendGapReport(
    report: VerificationGapReport,
  ): Promise<VerificationGapReport> {
    if (this.gaps.has(report.id) ||
      await this.findGapReportByVerification(report)) {
      throw new Error("Verification gap report already exists");
    }
    this.gaps.set(report.id, structuredClone(report));
    return structuredClone(report);
  }

  async getGapReport(
    input: GoalVerificationScope & { reportId: string },
  ): Promise<VerificationGapReport | null> {
    const value = this.gaps.get(input.reportId);
    return value && scopeKey(value) === scopeKey(input)
      ? structuredClone(value)
      : null;
  }

  async findGapReportByVerification(
    input: GoalVerificationScope & { verificationId: string },
  ): Promise<VerificationGapReport | null> {
    const value = scoped(this.gaps.values(), input).find((report) =>
      report.verificationId === input.verificationId
    );
    return value ? structuredClone(value) : null;
  }

  async listGapReports(scope: GoalVerificationScope) {
    return structuredClone(scoped(this.gaps.values(), scope)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  async findGapRemediation(input: {
    organizationId: string;
    reportId: string;
    actorId: string;
    idempotencyKey: string;
  }): Promise<{ requestHash: string; receipt: GapRemediationReceipt } | null> {
    const value = this.remediations.get(
      `${input.organizationId}/${input.reportId}/${input.actorId}/${input.idempotencyKey}`,
    );
    return value ? structuredClone(value) : null;
  }

  async saveGapRemediation(input: {
    organizationId: string;
    reportId: string;
    actorId: string;
    idempotencyKey: string;
    requestHash: string;
    receipt: GapRemediationReceipt;
  }): Promise<GapRemediationReceipt> {
    const key = `${input.organizationId}/${input.reportId}/${input.actorId}/${input.idempotencyKey}`;
    const existing = this.remediations.get(key);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new Error("Gap remediation idempotency conflict");
      }
      return structuredClone(existing.receipt);
    }
    this.remediations.set(key, {
      requestHash: input.requestHash,
      receipt: structuredClone(input.receipt),
    });
    return structuredClone(input.receipt);
  }

  async appendDeliveryReport(report: DeliveryReport): Promise<DeliveryReport> {
    if (this.reports.has(report.id)) throw new Error("Delivery Report already exists");
    const latest = (await this.listDeliveryReports(report)).at(-1);
    if ((latest?.id ?? null) !== report.previousReportId ||
      report.revision !== (latest?.revision ?? 0) + 1) {
      throw new Error("Delivery Report revision conflict");
    }
    this.reports.set(report.id, structuredClone(report));
    return structuredClone(report);
  }

  async getDeliveryReport(
    input: GoalVerificationScope & { reportId: string },
  ): Promise<DeliveryReport | null> {
    const value = this.reports.get(input.reportId);
    return value && scopeKey(value) === scopeKey(input)
      ? structuredClone(value)
      : null;
  }

  async listDeliveryReports(
    scope: GoalVerificationScope,
  ): Promise<readonly DeliveryReport[]> {
    return structuredClone(scoped(this.reports.values(), scope)
      .sort((left, right) => left.revision - right.revision));
  }

  async acceptDeliveryReport(input: {
    current: DeliveryReport;
    accepted: DeliveryReport;
    expectedGoalVersion: number;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<{ report: DeliveryReport; goal: GoalContract }> {
    const operationKey = `${input.current.organizationId}/${input.accepted.humanAcceptance?.actorId}/${input.idempotencyKey}`;
    const replay = this.acceptanceOperations.get(operationKey);
    if (replay) {
      if (replay.requestHash !== input.requestHash) {
        throw new Error("Delivery acceptance idempotency conflict");
      }
      return structuredClone(replay.result);
    }
    const latest = (await this.listDeliveryReports(input.current)).at(-1);
    const goal = this.goals.get(scopeKey(input.current));
    if (!latest || latest.id !== input.current.id || !goal ||
      goal.status !== "verifying" || goal.version !== input.expectedGoalVersion ||
      input.accepted.previousReportId !== input.current.id ||
      input.accepted.status !== "accepted") {
      throw new Error("Delivery acceptance version conflict");
    }
    this.reports.set(input.accepted.id, structuredClone(input.accepted));
    const completed: GoalContract = {
      ...goal,
      status: "completed",
      version: goal.version + 1,
      updatedAt: input.accepted.generatedAt,
    };
    this.goals.set(
      scopeKey({ ...completed, goalId: completed.id }),
      structuredClone(completed),
    );
    const result = {
      report: structuredClone(input.accepted),
      goal: structuredClone(completed),
    };
    this.acceptanceOperations.set(operationKey, {
      requestHash: input.requestHash,
      result: structuredClone(result),
    });
    return result;
  }

  async getGoal(scope: GoalVerificationScope): Promise<GoalContract | null> {
    const goal = this.goals.get(scopeKey(scope));
    return goal ? structuredClone(goal) : null;
  }

  async synchronizeGoal(goal: GoalContract): Promise<void> {
    const key = scopeKey({
      organizationId: goal.organizationId,
      projectId: goal.projectId,
      goalId: goal.id,
    });
    const current = this.goals.get(key);
    if (!current || current.version <= goal.version) {
      this.goals.set(key, structuredClone(goal));
    }
  }
}
