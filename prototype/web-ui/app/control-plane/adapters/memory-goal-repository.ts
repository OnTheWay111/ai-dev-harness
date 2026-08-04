import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import type {
  CommitGoalTransition,
  GoalAggregate,
  GoalAuditEvent,
  GoalCommitResult,
  GoalIdempotencyLookup,
  GoalRepository,
  GoalScope,
  GoalStateChangedEvent,
  GoalTransitionReceipt,
} from "../ports/goal-repository.ts";

function key(scope: GoalScope): string {
  return `${scope.organizationId}/${scope.projectId}/${scope.id}`;
}

function idempotencyKey(lookup: GoalIdempotencyLookup): string {
  return `${lookup.organizationId}/${lookup.actorId}/${lookup.endpoint}/${lookup.key}`;
}

interface MemoryIdempotencyRecord extends GoalIdempotencyLookup {
  status: "completed" | "in_progress";
  responseDigest: string;
  expiresAt: string;
  receipt?: GoalTransitionReceipt;
}

export class MemoryGoalRepository implements GoalRepository {
  private readonly goals = new Map<string, GoalAggregate>();
  private readonly events: GoalStateChangedEvent[] = [];
  private readonly audits: GoalAuditEvent[] = [];
  private readonly idempotency = new Map<string, MemoryIdempotencyRecord>();

  constructor(initialGoals: readonly GoalAggregate[] = []) {
    for (const goal of initialGoals) {
      this.goals.set(key(goal), { ...goal });
    }
  }

  get committedEvents(): GoalStateChangedEvent[] {
    return structuredClone(this.events);
  }

  get committedAuditEvents(): GoalAuditEvent[] {
    return structuredClone(this.audits);
  }

  get idempotencyRecords(): MemoryIdempotencyRecord[] {
    return structuredClone([...this.idempotency.values()]);
  }

  async get(scope: GoalScope): Promise<GoalAggregate | null> {
    const goal = this.goals.get(key(scope));
    return goal ? { ...goal } : null;
  }

  async findIdempotentReceipt(
    lookup: GoalIdempotencyLookup,
  ): Promise<GoalTransitionReceipt | null> {
    const record = this.idempotency.get(idempotencyKey(lookup));
    if (!record) return null;
    if (record.requestHash !== lookup.requestHash) {
      throw new IdempotencyConflictError();
    }
    if (record.status !== "completed" || !record.receipt) {
      throw new IdempotencyInProgressError();
    }
    return structuredClone(record.receipt);
  }

  async commitTransition(
    command: CommitGoalTransition,
  ): Promise<GoalCommitResult> {
    const existing = this.idempotency.get(
      idempotencyKey(command.idempotency),
    );
    if (existing) {
      if (existing.requestHash !== command.idempotency.requestHash) {
        throw new IdempotencyConflictError();
      }
      if (existing.status !== "completed" || !existing.receipt) {
        throw new IdempotencyInProgressError();
      }
      const replayedGoal = this.goals.get(key(command.current));
      if (!replayedGoal) throw new VersionConflictError();
      return {
        goal: { ...replayedGoal },
        receipt: structuredClone(existing.receipt),
      };
    }
    const current = this.goals.get(key(command.current));
    if (
      !current ||
      current.version !== command.expectedVersion ||
      command.event.aggregateVersion !== command.expectedVersion + 1
    ) {
      throw new VersionConflictError();
    }
    if (
      this.events.some((event) =>
        event.id === command.event.id ||
        (event.aggregateId === command.event.aggregateId &&
          event.aggregateVersion === command.event.aggregateVersion &&
          event.type === command.event.type)
      )
    ) {
      throw new VersionConflictError();
    }
    if (
      this.audits.some((audit) => audit.id === command.audit.id) ||
      command.audit.entityVersion !== command.expectedVersion + 1 ||
      command.receipt.version !== command.expectedVersion + 1
    ) {
      throw new VersionConflictError();
    }
    const next = {
      ...current,
      status: command.nextState,
      version: command.expectedVersion + 1,
    };
    this.goals.set(key(next), next);
    this.events.push(structuredClone(command.event));
    this.audits.push(structuredClone(command.audit));
    this.idempotency.set(idempotencyKey(command.idempotency), {
      organizationId: command.idempotency.organizationId,
      actorId: command.idempotency.actorId,
      endpoint: command.idempotency.endpoint,
      key: command.idempotency.key,
      requestHash: command.idempotency.requestHash,
      responseDigest: command.idempotency.responseDigest,
      expiresAt: command.idempotency.expiresAt.toISOString(),
      status: "completed",
      receipt: structuredClone(command.receipt),
    });
    return { goal: { ...next }, receipt: structuredClone(command.receipt) };
  }
}
