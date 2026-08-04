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

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface SqlExecutor {
  query<Row extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

interface TransactionClient extends SqlExecutor {
  release(): void;
}

export interface GoalWorkspacePool extends SqlExecutor {
  connect(): Promise<TransactionClient>;
}

interface GoalRow {
  id: string;
  organization_id: string;
  project_id: string;
  title: string;
  problem_statement: string;
  desired_outcome: string;
  non_goals: unknown;
  constraints: unknown;
  status: GoalContract["status"];
  version: number;
  created_at: Date;
  updated_at: Date;
  acceptance_criteria: unknown;
}

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed" | "failed";
  payload: unknown;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : [];
}

function mapGoal(row: GoalRow): GoalContract {
  const criteria = Array.isArray(row.acceptance_criteria)
    ? row.acceptance_criteria as Array<Record<string, unknown>>
    : [];
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    title: row.title,
    problemStatement: row.problem_statement,
    desiredOutcome: row.desired_outcome,
    acceptanceCriteria: criteria.map((criterion) => ({
      id: String(criterion.id),
      position: Number(criterion.position),
      statement: String(criterion.statement),
      version: Number(criterion.version),
    })),
    nonGoals: stringList(row.non_goals),
    constraints: stringList(row.constraints),
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function receiptFromPayload(payload: unknown): GoalWorkspaceReceipt | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const receipt = (payload as Record<string, unknown>).receipt;
  return receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? structuredClone(receipt) as GoalWorkspaceReceipt
    : null;
}

async function findReceipt(
  executor: SqlExecutor,
  lookup: GoalWorkspaceIdempotencyLookup,
): Promise<GoalWorkspaceReceipt | null> {
  const result = await executor.query<IdempotencyRow>(
    `SELECT ir.request_hash, ir.status, oe.payload
       FROM idempotency_records ir
       LEFT JOIN outbox_events oe ON oe.id::text = ir.response_ref
      WHERE ir.organization_id = $1 AND ir.actor_id = $2
        AND ir.endpoint = $3 AND ir.key = $4`,
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

async function claim(
  client: SqlExecutor,
  input: CommitGoalCreate["idempotency"] | CommitGoalUpdate["idempotency"],
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO idempotency_records
       (organization_id, actor_id, endpoint, key, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5,
             GREATEST($6::timestamptz, CURRENT_TIMESTAMP + interval '24 hours'))
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

async function insertCriteria(executor: SqlExecutor, goal: GoalContract) {
  for (const criterion of goal.acceptanceCriteria) {
    await executor.query(
      `INSERT INTO acceptance_criteria
         (id, organization_id, project_id, goal_id, position, statement,
          version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [
        criterion.id,
        goal.organizationId,
        goal.projectId,
        goal.id,
        criterion.position,
        criterion.statement,
        criterion.version,
        new Date(goal.updatedAt),
      ],
    );
  }
}

async function insertAudit(
  executor: SqlExecutor,
  audit: GoalWorkspaceAuditEvent,
) {
  const createdAt = new Date(audit.createdAt);
  await executor.query(
    `INSERT INTO audit_events
       (id, organization_id, project_id, goal_id, actor_id, action,
        entity_type, entity_id, entity_version, reason, request_id,
        retention_until, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13)`,
    [
      audit.id,
      audit.organizationId,
      audit.projectId,
      audit.goalId,
      audit.actorId,
      audit.action,
      audit.entityType,
      audit.entityId,
      audit.entityVersion,
      audit.reason,
      audit.requestId,
      new Date(createdAt.getTime() + 365 * 24 * 60 * 60 * 1_000),
      createdAt,
    ],
  );
}

async function complete(
  executor: SqlExecutor,
  input: {
    event: GoalWorkspaceEvent;
    audit: GoalWorkspaceAuditEvent;
    idempotency: CommitGoalCreate["idempotency"];
    receipt: GoalWorkspaceReceipt;
    status: 200 | 201;
  },
) {
  await insertAudit(executor, input.audit);
  await executor.query(
    `INSERT INTO outbox_events
       (id, organization_id, aggregate_type, aggregate_id,
        aggregate_version, event_type, deduplication_key, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.event.id,
      input.event.organizationId,
      input.event.aggregateType,
      input.event.aggregateId,
      input.event.aggregateVersion,
      input.event.type,
      input.event.id,
      JSON.stringify({ ...input.event.payload, receipt: input.receipt }),
    ],
  );
  const updated = await executor.query(
    `UPDATE idempotency_records
        SET status = 'completed', response_status = $1,
            response_ref = $2, response_digest = $3,
            updated_at = CURRENT_TIMESTAMP
      WHERE organization_id = $4 AND actor_id = $5
        AND endpoint = $6 AND key = $7 AND status = 'in_progress'`,
    [
      input.status,
      input.event.id,
      input.idempotency.responseDigest,
      input.idempotency.organizationId,
      input.idempotency.actorId,
      input.idempotency.endpoint,
      input.idempotency.key,
    ],
  );
  if (updated.rowCount !== 1) throw new IdempotencyInProgressError();
}

export class PostgresGoalWorkspaceRepository implements GoalWorkspaceRepository {
  private readonly pool: GoalWorkspacePool;

  constructor(pool: GoalWorkspacePool) {
    this.pool = pool;
  }

  async get(scope: GoalWorkspaceScope): Promise<GoalContract | null> {
    const result = await this.pool.query<GoalRow>(
      `SELECT g.id, g.organization_id, g.project_id, g.title,
              g.problem_statement, g.desired_outcome, g.non_goals,
              g.constraints, g.status, g.version, g.created_at, g.updated_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', ac.id, 'position', ac.position,
                'statement', ac.statement, 'version', ac.version
              ) ORDER BY ac.position) FILTER (WHERE ac.id IS NOT NULL), '[]'::jsonb)
                AS acceptance_criteria
         FROM goals g
         LEFT JOIN acceptance_criteria ac
           ON ac.organization_id = g.organization_id
          AND ac.project_id = g.project_id AND ac.goal_id = g.id
        WHERE g.id = $1 AND g.organization_id = $2 AND g.project_id = $3
        GROUP BY g.id`,
      [scope.id, scope.organizationId, scope.projectId],
    );
    return result.rows[0] ? mapGoal(result.rows[0]) : null;
  }

  async findIdempotentReceipt(
    lookup: GoalWorkspaceIdempotencyLookup,
  ): Promise<GoalWorkspaceReceipt | null> {
    return await findReceipt(this.pool, lookup);
  }

  async commitCreate(command: CommitGoalCreate): Promise<GoalWorkspaceReceipt> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!await claim(client, command.idempotency)) {
        const receipt = await findReceipt(client, command.idempotency);
        if (!receipt) throw new IdempotencyInProgressError();
        await client.query("COMMIT");
        return receipt;
      }
      const result = await client.query(
        `INSERT INTO goals
           (id, organization_id, project_id, title, problem_statement,
            desired_outcome, non_goals, constraints, status, version,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
                 'draft', 1, $9, $9)`,
        [
          command.goal.id,
          command.goal.organizationId,
          command.goal.projectId,
          command.goal.title,
          command.goal.problemStatement,
          command.goal.desiredOutcome,
          JSON.stringify(command.goal.nonGoals),
          JSON.stringify(command.goal.constraints),
          new Date(command.goal.createdAt),
        ],
      );
      if (result.rowCount !== 1) throw new VersionConflictError();
      await insertCriteria(client, command.goal);
      await complete(client, { ...command, status: 201 });
      await client.query("COMMIT");
      return structuredClone(command.receipt);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async commitUpdate(command: CommitGoalUpdate): Promise<GoalWorkspaceReceipt> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!await claim(client, command.idempotency)) {
        const receipt = await findReceipt(client, command.idempotency);
        if (!receipt) throw new IdempotencyInProgressError();
        await client.query("COMMIT");
        return receipt;
      }
      const result = await client.query(
        `UPDATE goals
            SET title = $1, problem_statement = $2, desired_outcome = $3,
                non_goals = $4::jsonb, constraints = $5::jsonb,
                version = version + 1, updated_at = $6
          WHERE id = $7 AND organization_id = $8 AND project_id = $9
            AND version = $10`,
        [
          command.next.title,
          command.next.problemStatement,
          command.next.desiredOutcome,
          JSON.stringify(command.next.nonGoals),
          JSON.stringify(command.next.constraints),
          new Date(command.next.updatedAt),
          command.next.id,
          command.next.organizationId,
          command.next.projectId,
          command.expectedVersion,
        ],
      );
      if (result.rowCount !== 1) throw new VersionConflictError();
      await client.query(
        `DELETE FROM acceptance_criteria
          WHERE organization_id = $1 AND project_id = $2 AND goal_id = $3`,
        [command.next.organizationId, command.next.projectId, command.next.id],
      );
      await insertCriteria(client, command.next);
      await complete(client, { ...command, status: 200 });
      await client.query("COMMIT");
      return structuredClone(command.receipt);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
