import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import type { GoalContract } from "../domain/goal-contract.ts";
import type {
  CommitGoalCreate,
  CommitGoalUpdate,
  GoalWorkspaceAuditEvent,
  GoalWorkspaceEvent,
  GoalWorkspaceIdempotencyLookup,
  GoalWorkspaceReceipt,
  GoalWorkspaceRepository,
  GoalWorkspaceScope,
} from "../ports/goal-workspace-repository.ts";

function goalKey(scope: GoalWorkspaceScope): string {
  return `${scope.organizationId}/${scope.projectId}/${scope.id}`;
}

function idempotencyKey(lookup: GoalWorkspaceIdempotencyLookup): string {
  return `${lookup.organizationId}/${lookup.actorId}/${lookup.endpoint}/${lookup.key}`;
}

interface MemoryIdempotencyRecord extends GoalWorkspaceIdempotencyLookup {
  status: "completed" | "in_progress";
  receipt?: GoalWorkspaceReceipt;
}

export class MemoryGoalWorkspaceRepository implements GoalWorkspaceRepository {
  private readonly goals = new Map<string, GoalContract>();
  private readonly events: GoalWorkspaceEvent[] = [];
  private readonly audits: GoalWorkspaceAuditEvent[] = [];
  private readonly idempotency = new Map<string, MemoryIdempotencyRecord>();

  constructor(initialGoals: readonly GoalContract[] = []) {
    for (const goal of initialGoals) this.goals.set(goalKey(goal), structuredClone(goal));
  }

  get committedEvents(): GoalWorkspaceEvent[] {
    return structuredClone(this.events);
  }

  get committedAuditEvents(): GoalWorkspaceAuditEvent[] {
    return structuredClone(this.audits);
  }

  async get(scope: GoalWorkspaceScope): Promise<GoalContract | null> {
    const goal = this.goals.get(goalKey(scope));
    return goal ? structuredClone(goal) : null;
  }

  async findIdempotentReceipt(
    lookup: GoalWorkspaceIdempotencyLookup,
  ): Promise<GoalWorkspaceReceipt | null> {
    const record = this.idempotency.get(idempotencyKey(lookup));
    if (!record) return null;
    if (record.requestHash !== lookup.requestHash) throw new IdempotencyConflictError();
    if (record.status !== "completed" || !record.receipt) {
      throw new IdempotencyInProgressError();
    }
    return structuredClone(record.receipt);
  }

  async commitCreate(command: CommitGoalCreate): Promise<GoalWorkspaceReceipt> {
    const replay = await this.replay(command.idempotency);
    if (replay) return replay;
    if (this.goals.has(goalKey(command.goal))) throw new VersionConflictError();
    this.goals.set(goalKey(command.goal), structuredClone(command.goal));
    return this.complete(command);
  }

  async commitUpdate(command: CommitGoalUpdate): Promise<GoalWorkspaceReceipt> {
    const replay = await this.replay(command.idempotency);
    if (replay) return replay;
    const current = this.goals.get(goalKey(command.current));
    if (
      !current ||
      current.version !== command.expectedVersion ||
      command.next.version !== command.expectedVersion + 1
    ) {
      throw new VersionConflictError();
    }
    this.goals.set(goalKey(command.next), structuredClone(command.next));
    return this.complete(command);
  }

  private async replay(
    lookup: GoalWorkspaceIdempotencyLookup,
  ): Promise<GoalWorkspaceReceipt | null> {
    return await this.findIdempotentReceipt(lookup);
  }

  private complete(
    command: CommitGoalCreate | CommitGoalUpdate,
  ): GoalWorkspaceReceipt {
    this.events.push(structuredClone(command.event));
    this.audits.push(structuredClone(command.audit));
    this.idempotency.set(idempotencyKey(command.idempotency), {
      organizationId: command.idempotency.organizationId,
      actorId: command.idempotency.actorId,
      endpoint: command.idempotency.endpoint,
      key: command.idempotency.key,
      requestHash: command.idempotency.requestHash,
      status: "completed",
      receipt: structuredClone(command.receipt),
    });
    return structuredClone(command.receipt);
  }
}
