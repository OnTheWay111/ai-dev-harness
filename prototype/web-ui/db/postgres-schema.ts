import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type {
  GlobalTask,
  TaskPriority,
  TaskStage,
  WorkbenchSnapshot,
} from "../app/workbench/contracts";

export const repositoryProviders = ["github"] as const;
export type RepositoryProvider = (typeof repositoryProviders)[number];

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("organizations_slug_uidx").on(table.slug),
    check(
      "organizations_slug_format_chk",
      sql`char_length(${table.slug}) BETWEEN 1 AND 64 AND (${table.slug} ~ '^[a-z]$' OR ${table.slug} ~ '^[a-z][a-z0-9-]*[a-z0-9]$')`,
    ),
    check(
      "organizations_name_length_chk",
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND 200`,
    ),
    check(
      "organizations_version_positive_chk",
      sql`${table.version} > 0`,
    ),
    check(
      "organizations_timestamps_order_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "projects_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    unique("projects_organization_id_id_uidx").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("projects_organization_slug_uidx").on(
      table.organizationId,
      table.slug,
    ),
    check(
      "projects_slug_format_chk",
      sql`char_length(${table.slug}) BETWEEN 1 AND 64 AND (${table.slug} ~ '^[a-z]$' OR ${table.slug} ~ '^[a-z][a-z0-9-]*[a-z0-9]$')`,
    ),
    check(
      "projects_name_length_chk",
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND 200`,
    ),
    check("projects_version_positive_chk", sql`${table.version} > 0`),
    check(
      "projects_timestamps_order_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    provider: text("provider").$type<RepositoryProvider>().notNull(),
    providerRepositoryId: text("provider_repository_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "repositories_project_organization_fk",
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("repositories_organization_project_id_uidx").on(
      table.organizationId,
      table.projectId,
      table.id,
    ),
    uniqueIndex("repositories_project_provider_id_uidx").on(
      table.organizationId,
      table.projectId,
      table.provider,
      table.providerRepositoryId,
    ),
    uniqueIndex("repositories_project_owner_name_uidx").on(
      table.organizationId,
      table.projectId,
      table.provider,
      table.owner,
      table.name,
    ),
    check(
      "repositories_provider_chk",
      sql`${table.provider} IN ('github')`,
    ),
    check(
      "repositories_identity_length_chk",
      sql`char_length(btrim(${table.providerRepositoryId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.owner})) BETWEEN 1 AND 200 AND char_length(btrim(${table.name})) BETWEEN 1 AND 200`,
    ),
    check(
      "repositories_default_branch_length_chk",
      sql`char_length(btrim(${table.defaultBranch})) BETWEEN 1 AND 255`,
    ),
    check("repositories_version_positive_chk", sql`${table.version} > 0`),
    check(
      "repositories_timestamps_order_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    title: text("title").notNull(),
    problemStatement: text("problem_statement").notNull(),
    desiredOutcome: text("desired_outcome").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "goals_project_organization_fk",
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    unique("goals_organization_project_id_uidx").on(
      table.organizationId,
      table.projectId,
      table.id,
    ),
    check(
      "goals_title_length_chk",
      sql`char_length(btrim(${table.title})) BETWEEN 1 AND 200`,
    ),
    check(
      "goals_problem_length_chk",
      sql`char_length(btrim(${table.problemStatement})) BETWEEN 1 AND 10000`,
    ),
    check(
      "goals_outcome_length_chk",
      sql`char_length(btrim(${table.desiredOutcome})) BETWEEN 1 AND 10000`,
    ),
    check("goals_version_positive_chk", sql`${table.version} > 0`),
    check(
      "goals_timestamps_order_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const acceptanceCriteria = pgTable(
  "acceptance_criteria",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    position: integer("position").notNull(),
    statement: text("statement").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "acceptance_criteria_goal_organization_fk",
      columns: [table.organizationId, table.projectId, table.goalId],
      foreignColumns: [
        goals.organizationId,
        goals.projectId,
        goals.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("acceptance_criteria_goal_position_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.position,
    ),
    check(
      "acceptance_criteria_position_positive_chk",
      sql`${table.position} > 0`,
    ),
    check(
      "acceptance_criteria_statement_length_chk",
      sql`char_length(btrim(${table.statement})) BETWEEN 1 AND 2000`,
    ),
    check(
      "acceptance_criteria_version_positive_chk",
      sql`${table.version} > 0`,
    ),
    check(
      "acceptance_criteria_timestamps_order_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
export type AcceptanceCriterion = typeof acceptanceCriteria.$inferSelect;
export type NewAcceptanceCriterion = typeof acceptanceCriteria.$inferInsert;

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
