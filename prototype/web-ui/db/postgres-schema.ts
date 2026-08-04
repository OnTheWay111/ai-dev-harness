import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import type {
  GlobalTask,
  TaskPriority,
  TaskStage,
  WorkbenchSnapshot,
} from "../app/workbench/contracts";

export const workbenchSnapshots = pgTable("workbench_snapshots", {
  scopeId: text("scope_id").primaryKey(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  generatedAt: timestamp("generated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  summary: jsonb("summary")
    .$type<WorkbenchSnapshot["summary"]>()
    .notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  })
    .defaultNow()
    .notNull(),
});

export const workbenchTasks = pgTable(
  "workbench_tasks",
  {
    scopeId: text("scope_id").notNull(),
    taskId: text("task_id").notNull(),
    goalId: text("goal_id").notNull(),
    priority: text("priority").$type<TaskPriority>().notNull(),
    stage: text("stage").$type<TaskStage>().notNull(),
    attentionRequired: boolean("attention_required").notNull(),
    rank: integer("rank").notNull(),
    payload: jsonb("payload").$type<GlobalTask>().notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeId, table.taskId] }),
    index("workbench_tasks_scope_rank_idx").on(table.scopeId, table.rank),
    index("workbench_tasks_scope_goal_idx").on(table.scopeId, table.goalId),
    index("workbench_tasks_scope_stage_idx").on(table.scopeId, table.stage),
    index("workbench_tasks_scope_attention_idx").on(
      table.scopeId,
      table.attentionRequired,
    ),
  ],
);
