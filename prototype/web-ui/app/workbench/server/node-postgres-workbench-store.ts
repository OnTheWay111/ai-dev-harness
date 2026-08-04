import type { Pool, PoolClient } from "pg";

import type { GlobalTask } from "../contracts.ts";
import { buildWorkbenchTaskRows } from
  "./neon-workbench-projection-writer.ts";
import type {
  PersistedWorkbenchPage,
  PostgresWorkbenchReadStore,
  ReadPersistedTasksInput,
} from "./postgres-workbench-repository.ts";
import type { WorkbenchSnapshot } from "../contracts.ts";

interface SnapshotRow {
  revision: string | number;
  generated_at: Date;
  summary: WorkbenchSnapshot["summary"];
}

function whereClause(input: ReadPersistedTasksInput): {
  text: string;
  values: unknown[];
} {
  const clauses = ["scope_id = $1"];
  const values: unknown[] = [input.scopeId];
  if (input.goalId) {
    values.push(input.goalId);
    clauses.push(`goal_id = $${values.length}`);
  }
  if (input.filter === "attention") {
    values.push(true);
    clauses.push(`attention_required = $${values.length}`);
  } else if (input.filter && input.filter !== "all") {
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
        `SELECT revision, generated_at, summary
         FROM workbench_snapshots
         WHERE scope_id = $1
         LIMIT 1`,
        [input.scopeId],
      );
      const where = whereClause(input);
      const tasks = await client.query<{ payload: GlobalTask }>(
        `SELECT payload
         FROM workbench_tasks
         WHERE ${where.text}
         ORDER BY rank ASC, task_id ASC
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
      await client.query("COMMIT");
      const snapshot = snapshots.rows[0];
      return {
        snapshot: snapshot
          ? {
              revision: Number(snapshot.revision),
              generatedAt: snapshot.generated_at,
              summary: snapshot.summary,
            }
          : null,
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
    scopeId: string,
    snapshot: WorkbenchSnapshot,
  ): Promise<void> {
    const generatedAt = new Date(snapshot.generatedAt);
    if (Number.isNaN(generatedAt.getTime())) {
      throw new Error("Workbench snapshot generatedAt is invalid");
    }
    const rows = buildWorkbenchTaskRows(scopeId, snapshot);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`workbench-projection:${scopeId}`],
      );
      await client.query(
        `INSERT INTO workbench_snapshots
           (scope_id, revision, generated_at, summary, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (scope_id) DO UPDATE SET
           revision = EXCLUDED.revision,
           generated_at = EXCLUDED.generated_at,
           summary = EXCLUDED.summary,
           updated_at = now()`,
        [
          scopeId,
          snapshot.revision,
          generatedAt,
          JSON.stringify(snapshot.summary),
        ],
      );
      await client.query(
        "DELETE FROM workbench_tasks WHERE scope_id = $1",
        [scopeId],
      );
      for (const row of rows) {
        await client.query(
          `INSERT INTO workbench_tasks
             (scope_id, task_id, goal_id, priority, stage,
              attention_required, rank, payload, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
          [
            row.scopeId,
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
