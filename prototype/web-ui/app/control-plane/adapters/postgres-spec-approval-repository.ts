import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import type {
  ScopeChange,
  SpecApprovalDecision,
  SpecApprovalDecisionRecord,
  SpecApprovalReceipt,
} from "../domain/spec-approval.ts";
import type {
  CommitSpecApproval,
  SpecApprovalIdempotency,
  SpecApprovalIdempotencyLookup,
  SpecApprovalRepository,
} from "../ports/spec-approval-repository.ts";
import type { SpecRevisionScope } from "../ports/spec-revision-repository.ts";
import type { GoalWorkspacePool } from "./postgres-goal-workspace-repository.ts";
import { PostgresSpecRevisionRepository } from
  "./postgres-spec-revision-repository.ts";

interface SqlExecutor {
  query<Row extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed" | "failed";
  payload: unknown;
}

interface DecisionRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  subject_id: string;
  subject_version: number;
  outcome: SpecApprovalDecision;
  actor_id: string;
  reason: string;
  request_id: string;
  policy_revision: string;
  affected_item_ids: string[];
  decision_payload: {
    helpfulExceptionElementIds?: string[];
    scopeChanges?: ScopeChange[];
    retainedElementIds?: string[];
    removedElementIds?: string[];
  };
  created_at: Date;
}

function values(scope: SpecRevisionScope): readonly string[] {
  return [scope.organizationId, scope.projectId, scope.goalId];
}

function receiptFromPayload(payload: unknown): SpecApprovalReceipt | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const receipt = (payload as Record<string, unknown>).receipt;
  return receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? structuredClone(receipt) as SpecApprovalReceipt
    : null;
}

async function findReceipt(
  executor: SqlExecutor,
  lookup: SpecApprovalIdempotencyLookup,
): Promise<SpecApprovalReceipt | null> {
  const result = await executor.query<IdempotencyRow>(
    `SELECT ir.request_hash, ir.status, oe.payload
       FROM idempotency_records ir
       LEFT JOIN outbox_events oe ON oe.id::text = ir.response_ref
      WHERE ir.organization_id=$1 AND ir.actor_id=$2
        AND ir.endpoint=$3 AND ir.key=$4`,
    [lookup.organizationId, lookup.actorId, lookup.endpoint, lookup.key],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== lookup.requestHash) throw new IdempotencyConflictError();
  if (row.status !== "completed") throw new IdempotencyInProgressError();
  const receipt = receiptFromPayload(row.payload);
  if (!receipt) throw new IdempotencyInProgressError();
  return receipt;
}

async function claim(executor: SqlExecutor, input: SpecApprovalIdempotency) {
  const result = await executor.query(
    `INSERT INTO idempotency_records
       (organization_id, actor_id, endpoint, key, request_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,GREATEST($6::timestamptz,CURRENT_TIMESTAMP + interval '24 hours'))
     ON CONFLICT (organization_id, actor_id, endpoint, key) DO NOTHING
     RETURNING id`,
    [
      input.organizationId,
      input.actorId,
      input.endpoint,
      input.key,
      input.requestHash,
      input.expiresAt,
    ],
  );
  return result.rowCount === 1;
}

function mapDecision(row: DecisionRow): SpecApprovalDecisionRecord {
  const payload = row.decision_payload ?? {};
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    specRevisionId: row.subject_id,
    subjectVersion: row.subject_version,
    decision: row.outcome,
    actorId: row.actor_id,
    reason: row.reason,
    requestId: row.request_id,
    policyRevision: row.policy_revision,
    affectedElementIds: row.affected_item_ids ?? [],
    helpfulExceptionElementIds: payload.helpfulExceptionElementIds ?? [],
    scopeChanges: payload.scopeChanges ?? [],
    retainedElementIds: payload.retainedElementIds ?? [],
    removedElementIds: payload.removedElementIds ?? [],
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresSpecApprovalRepository implements SpecApprovalRepository {
  private readonly pool: GoalWorkspacePool;
  private readonly revisions: PostgresSpecRevisionRepository;

  constructor(pool: GoalWorkspacePool) {
    this.pool = pool;
    this.revisions = new PostgresSpecRevisionRepository(pool);
  }

  async get(scope: SpecRevisionScope & { specRevisionId: string }) {
    return (await this.revisions.list(scope)).revisions
      .find(({ id }) => id === scope.specRevisionId) ?? null;
  }

  async getLatest(scope: SpecRevisionScope) {
    return (await this.revisions.list(scope)).revisions.at(-1) ?? null;
  }

  async approvalTimeline(scope: SpecRevisionScope & { specRevisionId: string }) {
    const result = await this.pool.query<DecisionRow>(
      `SELECT id, organization_id, project_id, goal_id, subject_id,
              subject_version, outcome, actor_id, reason, request_id,
              policy_revision, affected_item_ids, decision_payload, created_at
         FROM decisions
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
          AND subject_type='spec_revision' AND subject_id=$4
        ORDER BY created_at, id`,
      [...values(scope), scope.specRevisionId],
    );
    return { decisions: result.rows.map(mapDecision) };
  }

  async findApprovalReceipt(lookup: SpecApprovalIdempotencyLookup) {
    return await findReceipt(this.pool, lookup);
  }

  async commitApproval(command: CommitSpecApproval) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!await claim(client, command.idempotency)) {
        const replay = await findReceipt(client, command.idempotency);
        if (!replay) throw new IdempotencyInProgressError();
        await client.query("COMMIT");
        return replay;
      }
      const goalLock = await client.query(
        `SELECT id FROM goals
          WHERE organization_id=$1 AND project_id=$2 AND id=$3
          FOR UPDATE`,
        values(command.current),
      );
      if (goalLock.rowCount !== 1) throw new VersionConflictError();
      const locked = await client.query<{ version: number; status: string }>(
        `SELECT version, status FROM spec_revisions
          WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 AND id=$4
            AND NOT EXISTS (
              SELECT 1 FROM spec_revisions newer
               WHERE newer.organization_id=$1 AND newer.project_id=$2
                 AND newer.goal_id=$3 AND newer.revision > spec_revisions.revision
            )
          FOR UPDATE`,
        [...values(command.current), command.current.id],
      );
      if (
        locked.rows[0]?.version !== command.expectedVersion ||
        locked.rows[0]?.status !== command.current.status
      ) throw new VersionConflictError();
      const updated = await client.query(
        `UPDATE spec_revisions
            SET status=$1, version=version+1, updated_at=$2
          WHERE organization_id=$3 AND project_id=$4 AND goal_id=$5 AND id=$6
            AND version=$7`,
        [
          command.next.status,
          new Date(command.next.updatedAt),
          command.next.organizationId,
          command.next.projectId,
          command.next.goalId,
          command.next.id,
          command.expectedVersion,
        ],
      );
      if (updated.rowCount !== 1) throw new VersionConflictError();
      const decision = command.decision;
      await client.query(
        `INSERT INTO decisions
          (id, organization_id, project_id, goal_id, decision_key, revision,
           status, subject_type, subject_id, subject_version, outcome,
           actor_id, reason, request_id, policy_revision, affected_item_ids,
           decision_payload, created_at)
         VALUES
          ($1,$2,$3,$4,$16,1,$5,'spec_revision',$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,
        [
          decision.id,
          decision.organizationId,
          decision.projectId,
          decision.goalId,
          decision.decision === "submit_for_review"
            ? "proposed"
            : decision.decision === "approve" ? "approved" : "rejected",
          decision.specRevisionId,
          decision.subjectVersion,
          decision.decision,
          decision.actorId,
          decision.reason,
          decision.requestId,
          decision.policyRevision,
          JSON.stringify(decision.affectedElementIds),
          JSON.stringify({
            helpfulExceptionElementIds: decision.helpfulExceptionElementIds,
            scopeChanges: decision.scopeChanges,
            retainedElementIds: decision.retainedElementIds,
            removedElementIds: decision.removedElementIds,
          }),
          new Date(decision.createdAt),
          decision.id,
        ],
      );
      const audit = command.audit;
      await client.query(
        `INSERT INTO audit_events
          (id, organization_id, project_id, goal_id, actor_id, action,
           entity_type, entity_id, entity_version, reason, request_id,
           policy_revision, retention_until, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'spec_revision',$7,$8,$9,$10,$11,$12,$13)`,
        [
          audit.id,
          audit.organizationId,
          audit.projectId,
          audit.goalId,
          audit.actorId,
          audit.action,
          audit.entityId,
          audit.entityVersion,
          audit.reason,
          audit.requestId,
          audit.policyRevision,
          new Date(new Date(audit.createdAt).getTime() + 365 * 24 * 60 * 60 * 1_000),
          new Date(audit.createdAt),
        ],
      );
      const event = command.event;
      await client.query(
        `INSERT INTO outbox_events
          (id, organization_id, aggregate_type, aggregate_id,
           aggregate_version, event_type, deduplication_key, payload)
         VALUES ($1,$2,'spec_revision',$3,$4,$5,$7,$6::jsonb)`,
        [
          event.id,
          event.organizationId,
          event.aggregateId,
          event.aggregateVersion,
          event.type,
          JSON.stringify({ ...event.payload, receipt: command.receipt }),
          event.id,
        ],
      );
      const completed = await client.query(
        `UPDATE idempotency_records
            SET status='completed', response_status=200, response_ref=$1,
                response_digest=$2, updated_at=CURRENT_TIMESTAMP
          WHERE organization_id=$3 AND actor_id=$4 AND endpoint=$5 AND key=$6
            AND status='in_progress'`,
        [
          event.id,
          command.idempotency.responseDigest,
          command.idempotency.organizationId,
          command.idempotency.actorId,
          command.idempotency.endpoint,
          command.idempotency.key,
        ],
      );
      if (completed.rowCount !== 1) throw new IdempotencyInProgressError();
      await client.query("COMMIT");
      return structuredClone(command.receipt);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") {
        throw new IdempotencyConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
