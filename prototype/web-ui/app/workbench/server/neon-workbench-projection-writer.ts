import { and, eq } from "drizzle-orm";

import {
  workbenchSnapshots,
  workbenchTasks,
} from "../../../db/postgres-schema.ts";
import type { WorkbenchSnapshot } from "../contracts";
import type { NeonWorkbenchDatabase } from "./neon-workbench-store.ts";

export interface WorkbenchProjectionScope {
  scopeId: string;
  organizationId: string;
  projectId: string;
}

export function buildWorkbenchTaskRows(
  projection: WorkbenchProjectionScope,
  snapshot: WorkbenchSnapshot,
) {
  return snapshot.tasks.map((task, rank) => ({
    ...projection,
    taskId: task.id,
    goalId: task.goalId,
    priority: task.priority,
    stage: task.stage,
    attentionRequired: task.attention.required,
    rank,
    payload: task,
    updatedAt: new Date(task.progress.updatedAt),
  }));
}

export class NeonWorkbenchProjectionWriter {
  private readonly database: NeonWorkbenchDatabase;

  constructor(database: NeonWorkbenchDatabase) {
    this.database = database;
  }

  async replaceProjection(
    projection: WorkbenchProjectionScope,
    snapshot: WorkbenchSnapshot,
  ): Promise<void> {
    const generatedAt = new Date(snapshot.generatedAt);
    if (Number.isNaN(generatedAt.getTime())) {
      throw new Error("Workbench snapshot generatedAt is invalid");
    }

    const upsertSnapshot = this.database
      .insert(workbenchSnapshots)
      .values({
        ...projection,
        revision: snapshot.revision,
        generatedAt,
        summary: snapshot.summary,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          workbenchSnapshots.scopeId,
          workbenchSnapshots.organizationId,
          workbenchSnapshots.projectId,
        ],
        set: {
          revision: snapshot.revision,
          generatedAt,
          summary: snapshot.summary,
          updatedAt: new Date(),
        },
      });
    const deleteTasks = this.database
      .delete(workbenchTasks)
      .where(and(
        eq(workbenchTasks.scopeId, projection.scopeId),
        eq(workbenchTasks.organizationId, projection.organizationId),
        eq(workbenchTasks.projectId, projection.projectId),
      ));
    const taskRows = buildWorkbenchTaskRows(projection, snapshot);

    if (taskRows.length === 0) {
      await this.database.batch([upsertSnapshot, deleteTasks]);
      return;
    }
    await this.database.batch([
      upsertSnapshot,
      deleteTasks,
      this.database.insert(workbenchTasks).values(taskRows),
    ]);
  }
}
