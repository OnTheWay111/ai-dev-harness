import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";

import {
  roleBindings,
  workbenchSnapshots,
  workbenchTasks,
} from "../../../db/postgres-schema.ts";
import type {
  ActorVisibilityResolver,
  ActorVisibilityScope,
} from "../../auth/visibility-scope.ts";
import type { TaskStage } from "../contracts";
import type {
  PersistedWorkbenchPage,
  PostgresWorkbenchReadStore,
  ReadPersistedTasksInput,
} from "./postgres-workbench-repository.ts";
import { buildScopedWorkbenchSummary } from
  "./postgres-workbench-repository.ts";

export function createNeonWorkbenchDatabase(databaseUrl: string) {
  const client = neon(databaseUrl, { isolationLevel: "RepeatableRead" });
  return drizzle(client, {
    schema: { roleBindings, workbenchSnapshots, workbenchTasks },
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
    const visibility = input.visibility.organizationIds.length > 0 ||
        input.visibility.projectIds.length > 0
      ? or(
          input.visibility.organizationIds.length > 0
            ? inArray(
                workbenchTasks.organizationId,
                [...input.visibility.organizationIds],
              )
            : sql`false`,
          input.visibility.projectIds.length > 0
            ? inArray(
                workbenchTasks.projectId,
                [...input.visibility.projectIds],
              )
            : sql`false`,
        )
      : sql`false`;
    const snapshotVisibility = input.visibility.organizationIds.length > 0 ||
        input.visibility.projectIds.length > 0
      ? or(
          input.visibility.organizationIds.length > 0
            ? inArray(
                workbenchSnapshots.organizationId,
                [...input.visibility.organizationIds],
              )
            : sql`false`,
          input.visibility.projectIds.length > 0
            ? inArray(
                workbenchSnapshots.projectId,
                [...input.visibility.projectIds],
              )
            : sql`false`,
        )
      : sql`false`;
    const snapshotQuery = this.database
      .select({
        organizationId: workbenchSnapshots.organizationId,
        projectId: workbenchSnapshots.projectId,
        revision: workbenchSnapshots.revision,
        generatedAt: workbenchSnapshots.generatedAt,
        summary: workbenchSnapshots.summary,
      })
      .from(workbenchSnapshots)
      .where(and(
        eq(workbenchSnapshots.scopeId, input.scopeId),
        snapshotVisibility,
      ));
    const baseConditions = [
      eq(workbenchTasks.scopeId, input.scopeId),
      visibility,
    ];
    if (input.goalId) {
      baseConditions.push(eq(workbenchTasks.goalId, input.goalId));
    }
    const conditions = [...baseConditions];
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
        .orderBy(
          asc(workbenchTasks.rank),
          asc(workbenchTasks.organizationId),
          asc(workbenchTasks.projectId),
          asc(workbenchTasks.taskId),
        )
        .limit(input.limit)
        .offset(input.offset);
    const countQuery =
      this.database
        .select({ value: count() })
        .from(workbenchTasks)
        .where(where);
    const summaryWhere = and(...baseConditions);
    const summaryQuery = this.database
      .select({
        all: count(),
        attention: sql<number>`count(*) FILTER (
          WHERE ${workbenchTasks.attentionRequired}
        )::integer`,
        running: sql<number>`count(*) FILTER (
          WHERE ${workbenchTasks.stage} = 'running'
        )::integer`,
        review: sql<number>`count(*) FILTER (
          WHERE ${workbenchTasks.stage} = 'review'
        )::integer`,
        blocked: sql<number>`count(*) FILTER (
          WHERE ${workbenchTasks.stage} = 'blocked'
        )::integer`,
        waiting: sql<number>`count(*) FILTER (
          WHERE ${workbenchTasks.stage} = 'waiting'
        )::integer`,
        activeWorkers: sql<number>`count(DISTINCT
          ${workbenchTasks.payload} #>> '{execution,actorId}'
        ) FILTER (WHERE ${workbenchTasks.stage} = 'running')::integer`,
      })
      .from(workbenchTasks)
      .where(summaryWhere);

    const [snapshots, rows, totals, summaries] = await this.database.batch([
      snapshotQuery,
      taskQuery,
      countQuery,
      summaryQuery,
    ]);

    const latest = snapshots.reduce<(typeof snapshots)[number] | undefined>(
      (current, row) =>
        !current || row.generatedAt > current.generatedAt ? row : current,
      undefined,
    );
    const visibleRevision = snapshots.reduce(
      (total, row) => total + Number(row.revision),
      0,
    );
    const counts = summaries[0];

    return {
      snapshot: counts
        ? {
            revision: visibleRevision,
            generatedAt: latest?.generatedAt ?? new Date(0),
            summary: buildScopedWorkbenchSummary({
              all: Number(counts.all),
              attention: Number(counts.attention),
              running: Number(counts.running),
              review: Number(counts.review),
              blocked: Number(counts.blocked),
              waiting: Number(counts.waiting),
              activeWorkers: Number(counts.activeWorkers),
            }, snapshots.map((row) => row.summary)),
            cacheTag: snapshots
              .sort((left, right) =>
                `${left.organizationId}/${left.projectId}`.localeCompare(
                  `${right.organizationId}/${right.projectId}`,
                )
              )
              .map((row) =>
                `${row.organizationId}/${row.projectId}:${row.revision}:` +
                  row.generatedAt.toISOString()
              )
              .join("|"),
          }
        : null,
      tasks: rows.map((row) => row.payload),
      total: Number(totals[0]?.value ?? 0),
    };
  }
}

export class NeonActorVisibilityResolver
  implements ActorVisibilityResolver
{
  private readonly database: NeonWorkbenchDatabase;

  constructor(database: NeonWorkbenchDatabase) {
    this.database = database;
  }

  async resolve(actorId: string): Promise<ActorVisibilityScope> {
    if (!actorId) throw new Error("actorId is required to resolve visibility");
    const rows = await this.database
      .select({
        organizationId: roleBindings.organizationId,
        projectId: roleBindings.projectId,
        role: roleBindings.role,
      })
      .from(roleBindings)
      .where(and(
        eq(roleBindings.actorId, actorId),
        isNull(roleBindings.revokedAt),
      ));
    return {
      actorId,
      organizationIds: [...new Set(rows
        .filter((binding) =>
          binding.role === "organization_owner" && binding.projectId === null
        )
        .map((binding) => binding.organizationId))].sort(),
      projectIds: [...new Set(rows
        .filter((binding) => binding.projectId !== null)
        .map((binding) => binding.projectId as string))].sort(),
    };
  }
}
