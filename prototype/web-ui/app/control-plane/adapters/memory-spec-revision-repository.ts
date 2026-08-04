import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import type { SpecRevision } from "../domain/spec-artifact.ts";
import type {
  SpecApprovalAuditEvent,
  SpecApprovalDecisionRecord,
  SpecApprovalEvent,
  SpecApprovalReceipt,
} from "../domain/spec-approval.ts";
import type {
  CommitSpecApproval,
  SpecApprovalIdempotencyLookup,
  SpecApprovalRepository,
} from "../ports/spec-approval-repository.ts";
import type {
  SpecRevisionRepository,
  SpecRevisionScope,
} from "../ports/spec-revision-repository.ts";

function scopeKey(scope: SpecRevisionScope): string {
  return `${scope.organizationId}/${scope.projectId}/${scope.goalId}`;
}

interface MemoryApprovalIdempotency extends SpecApprovalIdempotencyLookup {
  status: "in_progress" | "completed";
  receipt?: SpecApprovalReceipt;
}

function approvalKey(lookup: SpecApprovalIdempotencyLookup): string {
  return `${lookup.organizationId}/${lookup.actorId}/${lookup.endpoint}/${lookup.key}`;
}

export class MemorySpecRevisionRepository implements SpecRevisionRepository,
  SpecApprovalRepository {
  private readonly revisions = new Map<string, SpecRevision[]>();
  private readonly decisions: SpecApprovalDecisionRecord[] = [];
  private readonly audits: SpecApprovalAuditEvent[] = [];
  private readonly events: SpecApprovalEvent[] = [];
  private readonly approvalIdempotency = new Map<string, MemoryApprovalIdempotency>();

  constructor(initialRevisions: readonly SpecRevision[] = []) {
    for (const revision of initialRevisions) {
      const key = scopeKey(revision);
      this.revisions.set(key, [
        ...(this.revisions.get(key) ?? []),
        structuredClone(revision),
      ].sort((left, right) => left.revision - right.revision));
    }
  }

  get committedAuditEvents(): SpecApprovalAuditEvent[] {
    return structuredClone(this.audits);
  }

  get committedEvents(): SpecApprovalEvent[] {
    return structuredClone(this.events);
  }

  async list(scope: SpecRevisionScope) {
    return { revisions: structuredClone(this.revisions.get(scopeKey(scope)) ?? []) };
  }

  async append(input: Parameters<SpecRevisionRepository["append"]>[0]) {
    const key = scopeKey(input.revision);
    const existing = this.revisions.get(key) ?? [];
    const latest = existing.at(-1) ?? null;
    if (
      (latest?.id ?? null) !== input.expectedPreviousRevisionId ||
      input.revision.revision !== existing.length + 1 ||
      input.revision.sourceGoalVersion !== input.expectedGoalVersion
    ) throw new VersionConflictError();
    const next = structuredClone(input.revision);
    this.revisions.set(key, [...existing, next]);
    return structuredClone(next);
  }

  async get(scope: SpecRevisionScope & { specRevisionId: string }) {
    const revision = (this.revisions.get(scopeKey(scope)) ?? [])
      .find(({ id }) => id === scope.specRevisionId);
    return revision ? structuredClone(revision) : null;
  }

  async approvalTimeline(scope: SpecRevisionScope) {
    return {
      decisions: structuredClone(this.decisions.filter((decision) =>
        decision.organizationId === scope.organizationId &&
        decision.projectId === scope.projectId &&
        decision.goalId === scope.goalId
      )),
    };
  }

  async findApprovalReceipt(lookup: SpecApprovalIdempotencyLookup) {
    const record = this.approvalIdempotency.get(approvalKey(lookup));
    if (!record) return null;
    if (record.requestHash !== lookup.requestHash) throw new IdempotencyConflictError();
    if (record.status !== "completed" || !record.receipt) {
      throw new IdempotencyInProgressError();
    }
    return structuredClone(record.receipt);
  }

  async commitApproval(command: CommitSpecApproval) {
    const replay = await this.findApprovalReceipt(command.idempotency);
    if (replay) return replay;
    const key = scopeKey(command.current);
    const revisions = this.revisions.get(key) ?? [];
    const index = revisions.findIndex(({ id }) => id === command.current.id);
    if (
      index < 0 ||
      revisions[index].version !== command.expectedVersion ||
      command.next.version !== command.expectedVersion + 1
    ) throw new VersionConflictError();
    revisions[index] = structuredClone(command.next);
    this.revisions.set(key, revisions);
    this.decisions.push(structuredClone(command.decision));
    this.audits.push(structuredClone(command.audit));
    this.events.push(structuredClone(command.event));
    this.approvalIdempotency.set(approvalKey(command.idempotency), {
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
