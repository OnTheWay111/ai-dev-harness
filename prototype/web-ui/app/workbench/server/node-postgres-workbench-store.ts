import type { Pool, PoolClient } from "pg";

import type { GlobalTask } from "../contracts.ts";
import { buildWorkbenchTaskRows } from
  "./neon-workbench-projection-writer.ts";
import type { WorkbenchProjectionScope } from
  "./neon-workbench-projection-writer.ts";
import type {
  PersistedWorkbenchPage,
  PostgresWorkbenchReadStore,
  ReadPersistedTasksInput,
} from "./postgres-workbench-repository.ts";
import { buildScopedWorkbenchSummary } from
  "./postgres-workbench-repository.ts";
import type { WorkbenchSnapshot } from "../contracts.ts";

interface SnapshotRow {
  organization_id: string;
  project_id: string;
  revision: string | number;
  generated_at: Date;
}

interface SummaryRow {
  all_count: number;
  attention_count: number;
  running_count: number;
  review_count: number;
  blocked_count: number;
  waiting_count: number;
  active_workers: number;
}

function whereClause(
  input: ReadPersistedTasksInput,
  includeListFilter = true,
): {
  text: string;
  values: unknown[];
} {
  const clauses = [
    "scope_id = $1",
    "(organization_id = ANY($2::uuid[]) OR project_id = ANY($3::uuid[]))",
  ];
  const values: unknown[] = [
    input.scopeId,
    [...input.visibility.organizationIds],
    [...input.visibility.projectIds],
  ];
  if (input.goalId) {
    values.push(input.goalId);
    clauses.push(`goal_id = $${values.length}`);
  }
  if (includeListFilter && input.filter === "attention") {
    values.push(true);
    clauses.push(`attention_required = $${values.length}`);
  } else if (
    includeListFilter && input.filter && input.filter !== "all"
  ) {
    values.push(input.filter);
    clauses.push(`stage = $${values.length}`);
  }
  return { text: clauses.join(" AND "), values };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}

export class NodePostgresWorkbenchReadStore
  implements PostgresWorkbenchReadStore
{
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async readPage(
    input: ReadPersistedTasksInput,
  ): Promise<PersistedWorkbenchPage> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshots = await client.query<SnapshotRow>(
        `SELECT organization_id, project_id, revision, generated_at
         FROM workbench_snapshots
         WHERE scope_id = $1
           AND (organization_id = ANY($2::uuid[])
                OR project_id = ANY($3::uuid[]))
         ORDER BY organization_id, project_id`,
        [
          input.scopeId,
          [...input.visibility.organizationIds],
          [...input.visibility.projectIds],
        ],
      );
      const where = whereClause(input);
      const summaryWhere = whereClause(input, false);
      const tasks = await client.query<{ payload: GlobalTask }>(
        `SELECT payload
         FROM workbench_tasks
         WHERE ${where.text}
         ORDER BY rank ASC, organization_id ASC, project_id ASC, task_id ASC
         LIMIT $${where.values.length + 1}
         OFFSET $${where.values.length + 2}`,
        [...where.values, input.limit, input.offset],
      );
      const totals = await client.query<{ value: number }>(
        `SELECT count(*)::integer AS value
         FROM workbench_tasks
         WHERE ${where.text}`,
        where.values,
      );
      const summaries = await client.query<SummaryRow>(
        `SELECT count(*)::integer AS all_count,
                count(*) FILTER (WHERE attention_required)::integer
                  AS attention_count,
                count(*) FILTER (WHERE stage = 'running')::integer
                  AS running_count,
                count(*) FILTER (WHERE stage = 'review')::integer
                  AS review_count,
                count(*) FILTER (WHERE stage = 'blocked')::integer
                  AS blocked_count,
                count(*) FILTER (WHERE stage = 'waiting')::integer
                  AS waiting_count,
                count(DISTINCT payload #>> '{execution,actorId}')
                  FILTER (WHERE stage = 'running')::integer AS active_workers
           FROM workbench_tasks
          WHERE ${summaryWhere.text}`,
        summaryWhere.values,
      );
      await client.query("COMMIT");
      const snapshotRows = snapshots.rows;
      const latest = snapshotRows.reduce<SnapshotRow | undefined>(
        (current, row) =>
          !current || row.generated_at > current.generated_at ? row : current,
        undefined,
      );
      const maximumRevision = snapshotRows.reduce(
        (maximum, row) => Math.max(maximum, Number(row.revision)),
        0,
      );
      const counts = summaries.rows[0] ?? {
        all_count: 0,
        attention_count: 0,
        running_count: 0,
        review_count: 0,
        blocked_count: 0,
        waiting_count: 0,
        active_workers: 0,
      };
      return {
        snapshot: {
              revision: maximumRevision,
              generatedAt: latest?.generated_at ?? new Date(0),
              summary: buildScopedWorkbenchSummary({
                all: Number(counts.all_count),
                attention: Number(counts.attention_count),
                running: Number(counts.running_count),
                review: Number(counts.review_count),
                blocked: Number(counts.blocked_count),
                waiting: Number(counts.waiting_count),
                activeWorkers: Number(counts.active_workers),
              }),
              cacheTag: snapshotRows.map((row) =>
                `${row.organization_id}/${row.project_id}:` +
                  `${row.revision}:${row.generated_at.toISOString()}`
              ).join("|"),
            },
        tasks: tasks.rows.map((row) => row.payload),
        total: Number(totals.rows[0]?.value ?? 0),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

export class NodePostgresWorkbenchProjectionWriter {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async replaceProjection(
    projection: WorkbenchProjectionScope,
    snapshot: WorkbenchSnapshot,
  ): Promise<void> {
    const generatedAt = new Date(snapshot.generatedAt);
    if (Number.isNaN(generatedAt.getTime())) {
      throw new Error("Workbench snapshot generatedAt is invalid");
    }
    const rows = buildWorkbenchTaskRows(projection, snapshot);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          `workbench-projection:${projection.scopeId}:` +
            `${projection.organizationId}:${projection.projectId}`,
        ],
      );
      await client.query(
        `INSERT INTO workbench_snapshots
           (scope_id, organization_id, project_id, revision,
            generated_at, summary, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
         ON CONFLICT (scope_id, organization_id, project_id) DO UPDATE SET
           revision = EXCLUDED.revision,
           generated_at = EXCLUDED.generated_at,
           summary = EXCLUDED.summary,
           updated_at = now()`,
        [
          projection.scopeId,
          projection.organizationId,
          projection.projectId,
          snapshot.revision,
          generatedAt,
          JSON.stringify(snapshot.summary),
        ],
      );
      await client.query(
        `DELETE FROM workbench_tasks
          WHERE scope_id = $1 AND organization_id = $2 AND project_id = $3`,
        [projection.scopeId, projection.organizationId, projection.projectId],
      );
      for (const row of rows) {
        await client.query(
          `INSERT INTO workbench_tasks
             (scope_id, organization_id, project_id, task_id, goal_id,
              priority, stage, attention_required, rank, payload, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
          [
            row.scopeId,
            row.organizationId,
            row.projectId,
            row.taskId,
            row.goalId,
            row.priority,
            row.stage,
            row.attentionRequired,
            row.rank,
            JSON.stringify(row.payload),
            row.updatedAt,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
