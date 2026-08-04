import { PostgresVersionedStateStore } from
  "./postgres-versioned-state-store.ts";
import type { SqlExecutor } from "./postgres-versioned-state-store.ts";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
} from "../domain/errors.ts";
import type {
  CommitGoalTransition,
  GoalAggregate,
  GoalCommitResult,
  GoalIdempotencyLookup,
  GoalRepository,
  GoalScope,
  GoalTransitionReceipt,
} from "../ports/goal-repository.ts";

interface TransactionClient extends SqlExecutor {
  query<Row extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  release(): void;
}

export interface PostgresPool extends SqlExecutor {
  connect(): Promise<TransactionClient>;
}

interface GoalRow {
  id: string;
  organization_id: string;
  project_id: string;
  title: string;
  status: GoalAggregate["status"];
  version: number;
}

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed" | "failed";
  payload: unknown;
}

function mapGoal(row: GoalRow): GoalAggregate {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    version: row.version,
  };
}

function receiptFromPayload(payload: unknown): GoalTransitionReceipt | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const receipt = (payload as Record<string, unknown>).receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return null;
  }
  return structuredClone(receipt) as GoalTransitionReceipt;
}

async function findReceipt(
  executor: SqlExecutor,
  lookup: GoalIdempotencyLookup,
): Promise<GoalTransitionReceipt | null> {
  const result = await executor.query<IdempotencyRow>(
    `SELECT ir.request_hash, ir.status, oe.payload
       FROM idempotency_records ir
       LEFT JOIN outbox_events oe ON oe.id::text = ir.response_ref
      WHERE ir.organization_id = $1
        AND ir.actor_id = $2
        AND ir.endpoint = $3
        AND ir.key = $4`,
    [lookup.organizationId, lookup.actorId, lookup.endpoint, lookup.key],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== lookup.requestHash) {
    throw new IdempotencyConflictError();
  }
  if (row.status !== "completed") {
    throw new IdempotencyInProgressError();
  }
  const receipt = receiptFromPayload(row.payload);
  if (!receipt) throw new IdempotencyInProgressError();
  return receipt;
}

export class PostgresGoalRepository implements GoalRepository {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async get(scope: GoalScope): Promise<GoalAggregate | null> {
    const result = await this.pool.query<GoalRow>(
      `SELECT id, organization_id, project_id, title, status, version
         FROM goals
        WHERE id = $1 AND organization_id = $2 AND project_id = $3`,
      [scope.id, scope.organizationId, scope.projectId],
    );
    return result.rows[0] ? mapGoal(result.rows[0]) : null;
  }

  async findIdempotentReceipt(
    lookup: GoalIdempotencyLookup,
  ): Promise<GoalTransitionReceipt | null> {
    return findReceipt(this.pool, lookup);
  }

  async commitTransition(
    command: CommitGoalTransition,
  ): Promise<GoalCommitResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<{ id: string }>(
        `INSERT INTO idempotency_records
           (organization_id, actor_id, endpoint, key, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5,
                 GREATEST($6::timestamptz,
                          CURRENT_TIMESTAMP + interval '24 hours'))
         ON CONFLICT (organization_id, actor_id, endpoint, key) DO NOTHING
         RETURNING id`,
        [
          command.idempotency.organizationId,
          command.idempotency.actorId,
          command.idempotency.endpoint,
          command.idempotency.key,
          command.idempotency.requestHash,
          command.idempotency.expiresAt,
        ],
      );
      if (claimed.rowCount !== 1) {
        const receipt = await findReceipt(client, command.idempotency);
        if (!receipt) throw new IdempotencyInProgressError();
        await client.query("COMMIT");
        return {
          goal: {
            ...command.current,
            status: receipt.state,
            version: receipt.version,
          },
          receipt,
        };
      }
      const persisted = await new PostgresVersionedStateStore(client).persist({
        entity: "goal",
        id: command.current.id,
        organizationId: command.current.organizationId,
        projectId: command.current.projectId,
        expectedVersion: command.expectedVersion,
        nextState: command.nextState,
        occurredAt: command.occurredAt,
      });
      const auditRetention = new Date(
        new Date(command.audit.createdAt).getTime() + 180 * 24 * 60 * 60 * 1000,
      );
      await client.query(
        `INSERT INTO audit_events
           (id, organization_id, project_id, goal_id, actor_id, action,
            entity_type, entity_id, entity_version, reason, request_id,
            retention_until, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          command.audit.id,
          command.audit.organizationId,
          command.audit.projectId,
          command.audit.goalId,
          command.audit.actorId,
          command.audit.action,
          command.audit.entityType,
          command.audit.entityId,
          command.audit.entityVersion,
          command.audit.reason,
          command.audit.requestId,
          auditRetention,
          new Date(command.audit.createdAt),
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
           (id, organization_id, aggregate_type, aggregate_id,
            aggregate_version, event_type, deduplication_key, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          command.event.id,
          command.event.organizationId,
          command.event.aggregateType,
          command.event.aggregateId,
          command.event.aggregateVersion,
          command.event.type,
          command.event.id,
          JSON.stringify({
            ...command.event.payload,
            receipt: command.receipt,
          }),
        ],
      );
      const completed = await client.query(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_ref = $1, response_digest = $2,
                updated_at = CURRENT_TIMESTAMP
          WHERE organization_id = $3 AND actor_id = $4
            AND endpoint = $5 AND key = $6 AND status = 'in_progress'`,
        [
          command.event.id,
          command.idempotency.responseDigest,
          command.idempotency.organizationId,
          command.idempotency.actorId,
          command.idempotency.endpoint,
          command.idempotency.key,
        ],
      );
      if (completed.rowCount !== 1) {
        throw new IdempotencyInProgressError();
      }
      await client.query("COMMIT");
      return {
        goal: {
          ...command.current,
          status: persisted.state as GoalAggregate["status"],
          version: persisted.version,
        },
        receipt: structuredClone(command.receipt),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
