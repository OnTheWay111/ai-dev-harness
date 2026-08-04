import { and, asc, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";

import {
  workbenchSnapshots,
  workbenchTasks,
} from "../../../db/postgres-schema.ts";
import type { TaskStage } from "../contracts";
import type {
  PersistedWorkbenchPage,
  PostgresWorkbenchReadStore,
  ReadPersistedTasksInput,
} from "./postgres-workbench-repository.ts";

export function createNeonWorkbenchDatabase(databaseUrl: string) {
  const client = neon(databaseUrl, { isolationLevel: "RepeatableRead" });
  return drizzle(client, {
    schema: { workbenchSnapshots, workbenchTasks },
  });
}

export type NeonWorkbenchDatabase = ReturnType<
  typeof createNeonWorkbenchDatabase
>;

export class NeonWorkbenchReadStore implements PostgresWorkbenchReadStore {
  private readonly database: NeonWorkbenchDatabase;

  constructor(database: NeonWorkbenchDatabase) {
    this.database = database;
  }

  async readPage(
    input: ReadPersistedTasksInput,
  ): Promise<PersistedWorkbenchPage> {
    const snapshotQuery = this.database
      .select({
        revision: workbenchSnapshots.revision,
        generatedAt: workbenchSnapshots.generatedAt,
        summary: workbenchSnapshots.summary,
      })
      .from(workbenchSnapshots)
      .where(eq(workbenchSnapshots.scopeId, input.scopeId))
      .limit(1);
    const conditions = [eq(workbenchTasks.scopeId, input.scopeId)];
    if (input.goalId) {
      conditions.push(eq(workbenchTasks.goalId, input.goalId));
    }
    if (input.filter === "attention") {
      conditions.push(eq(workbenchTasks.attentionRequired, true));
    } else if (input.filter && input.filter !== "all") {
      conditions.push(
        eq(workbenchTasks.stage, input.filter as TaskStage),
      );
    }
    const where = and(...conditions);
    const taskQuery =
      this.database
        .select({ payload: workbenchTasks.payload })
        .from(workbenchTasks)
        .where(where)
        .orderBy(asc(workbenchTasks.rank), asc(workbenchTasks.taskId))
        .limit(input.limit)
        .offset(input.offset);
    const countQuery =
      this.database
        .select({ value: count() })
        .from(workbenchTasks)
        .where(where);

    const [snapshots, rows, totals] = await this.database.batch([
      snapshotQuery,
      taskQuery,
      countQuery,
    ]);

    return {
      snapshot: snapshots[0] ?? null,
      tasks: rows.map((row) => row.payload),
      total: Number(totals[0]?.value ?? 0),
    };
  }
}
