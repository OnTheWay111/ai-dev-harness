import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import type {
  CommitGoalTransition,
  GoalAuditEvent,
  GoalIdempotencyLookup,
  GoalRepository,
  GoalStateChangedEvent,
  GoalTransitionReceipt,
} from "../ports/goal-repository.ts";
import { MemoryGoalWorkspaceRepository } from
  "./memory-goal-workspace-repository.ts";

interface StoredTransition extends GoalIdempotencyLookup {
  receipt: GoalTransitionReceipt;
}

function key(input: GoalIdempotencyLookup): string {
  return `${input.organizationId}/${input.actorId}/${input.endpoint}/${input.key}`;
}

export class MemoryGoalWorkspaceTransitionRepository implements GoalRepository {
  private readonly workspace: MemoryGoalWorkspaceRepository;
  private readonly idempotency = new Map<string, StoredTransition>();
  private readonly events: GoalStateChangedEvent[] = [];
  private readonly audits: GoalAuditEvent[] = [];

  constructor(workspace: MemoryGoalWorkspaceRepository) {
    this.workspace = workspace;
  }

  async get(scope: Parameters<GoalRepository["get"]>[0]) {
    return await this.workspace.get(scope);
  }

  async findIdempotentReceipt(lookup: GoalIdempotencyLookup) {
    const record = this.idempotency.get(key(lookup));
    if (!record) return null;
    if (record.requestHash !== lookup.requestHash) throw new IdempotencyConflictError();
    if (!record.receipt) throw new IdempotencyInProgressError();
    return structuredClone(record.receipt);
  }

  async commitTransition(command: CommitGoalTransition) {
    const replay = await this.findIdempotentReceipt(command.idempotency);
    if (replay) {
      const goal = await this.get(command.current);
      if (!goal) throw new VersionConflictError();
      return { goal, receipt: replay };
    }
    const goal = this.workspace.applyStateTransition({
      scope: command.current,
      expectedVersion: command.expectedVersion,
      nextState: command.nextState,
      occurredAt: command.occurredAt,
    });
    this.events.push(structuredClone(command.event));
    this.audits.push(structuredClone(command.audit));
    this.idempotency.set(key(command.idempotency), {
      organizationId: command.idempotency.organizationId,
      actorId: command.idempotency.actorId,
      endpoint: command.idempotency.endpoint,
      key: command.idempotency.key,
      requestHash: command.idempotency.requestHash,
      receipt: structuredClone(command.receipt),
    });
    return { goal, receipt: structuredClone(command.receipt) };
  }
}
