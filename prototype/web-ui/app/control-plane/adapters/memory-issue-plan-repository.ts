import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import type { IssuePlan } from "../domain/issue-plan.ts";
import type {
  IssuePlanApprovalAuditEvent,
  IssuePlanApprovalEvent,
  IssuePlanApprovalReceipt,
} from "../domain/issue-plan-approval.ts";
import type {
  CommitIssuePlanApproval,
  IssuePlanIdempotencyLookup,
  IssuePlanRepository,
  IssuePlanScope,
} from "../ports/issue-plan-repository.ts";

function scopeKey(scope: IssuePlanScope): string {
  return `${scope.organizationId}/${scope.projectId}/${scope.goalId}`;
}

function idempotencyKey(input: IssuePlanIdempotencyLookup): string {
  return `${input.organizationId}/${input.actorId}/${input.endpoint}/${input.key}`;
}

interface IdempotencyRecord extends IssuePlanIdempotencyLookup {
  status: "in_progress" | "completed";
  receipt?: IssuePlanApprovalReceipt;
}

export class MemoryIssuePlanRepository implements IssuePlanRepository {
  private readonly plans = new Map<string, IssuePlan[]>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly audits: IssuePlanApprovalAuditEvent[] = [];
  private readonly events: IssuePlanApprovalEvent[] = [];

  constructor(initialPlans: readonly IssuePlan[] = []) {
    for (const plan of initialPlans) {
      const key = scopeKey(plan);
      this.plans.set(key, [...(this.plans.get(key) ?? []), structuredClone(plan)]
        .sort((left, right) => left.revision - right.revision));
    }
  }

  get auditEvents(): readonly IssuePlanApprovalAuditEvent[] {
    return structuredClone(this.audits);
  }

  get outboxEvents(): readonly IssuePlanApprovalEvent[] {
    return structuredClone(this.events);
  }

  async list(scope: IssuePlanScope) {
    return { plans: structuredClone(this.plans.get(scopeKey(scope)) ?? []) };
  }

  async get(scope: IssuePlanScope & { planId: string }) {
    const plan = (this.plans.get(scopeKey(scope)) ?? [])
      .find(({ id }) => id === scope.planId);
    return plan ? structuredClone(plan) : null;
  }

  async getLatest(scope: IssuePlanScope) {
    const plan = (this.plans.get(scopeKey(scope)) ?? []).at(-1);
    return plan ? structuredClone(plan) : null;
  }

  async append(input: { plan: IssuePlan; expectedPreviousPlanId: string | null }) {
    const key = scopeKey(input.plan);
    const plans = this.plans.get(key) ?? [];
    const previous = plans.at(-1) ?? null;
    if ((previous?.id ?? null) !== input.expectedPreviousPlanId ||
      input.plan.revision !== (previous?.revision ?? 0) + 1) {
      throw new VersionConflictError();
    }
    this.plans.set(key, [...plans, structuredClone(input.plan)]);
    return structuredClone(input.plan);
  }

  async findApprovalReceipt(lookup: IssuePlanIdempotencyLookup) {
    const record = this.idempotency.get(idempotencyKey(lookup));
    if (!record) return null;
    if (record.requestHash !== lookup.requestHash) throw new IdempotencyConflictError();
    if (record.status !== "completed" || !record.receipt) {
      throw new IdempotencyInProgressError();
    }
    return structuredClone(record.receipt);
  }

  async commitApproval(input: CommitIssuePlanApproval) {
    const replay = await this.findApprovalReceipt(input.idempotency);
    if (replay) return replay;
    const key = scopeKey(input.current);
    const plans = this.plans.get(key) ?? [];
    const index = plans.findIndex(({ id }) => id === input.current.id);
    if (index < 0 || index !== plans.length - 1 ||
      plans[index].version !== input.expectedVersion ||
      input.next.version !== input.expectedVersion + 1) {
      throw new VersionConflictError();
    }
    plans[index] = structuredClone(input.next);
    this.plans.set(key, plans);
    this.audits.push(structuredClone(input.audit));
    this.events.push(structuredClone(input.event));
    this.idempotency.set(idempotencyKey(input.idempotency), {
      ...input.idempotency,
      status: "completed",
      receipt: structuredClone(input.receipt),
    });
    return structuredClone(input.receipt);
  }
}
