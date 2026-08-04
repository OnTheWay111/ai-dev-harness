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

export const clarificationStatuses = [
  "open",
  "answered",
  "superseded",
] as const;
export type ClarificationStatus = (typeof clarificationStatuses)[number];

export const decisionStatuses = [
  "proposed",
  "approved",
  "rejected",
  "superseded",
] as const;
export type DecisionStatus = (typeof decisionStatuses)[number];

export const decisionSubjectTypes = [
  "clarification",
  "spec_revision",
  "issue_plan",
] as const;
export type DecisionSubjectType = (typeof decisionSubjectTypes)[number];

export const specRevisionStatuses = [
  "draft",
  "in_review",
  "approved",
  "rejected",
  "superseded",
] as const;
export type SpecRevisionStatus = (typeof specRevisionStatuses)[number];

export const issueStatuses = [
  "draft",
  "approved",
  "ready",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type IssueStatus = (typeof issueStatuses)[number];

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

export const clarifications = pgTable(
  "clarifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    revision: integer("revision").notNull(),
    previousClarificationId: uuid("previous_clarification_id"),
    status: text("status").$type<ClarificationStatus>().notNull(),
    question: text("question").notNull(),
    answer: text("answer"),
    sourceGoalVersion: integer("source_goal_version").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "clarifications_goal_organization_fk",
      columns: [table.organizationId, table.projectId, table.goalId],
      foreignColumns: [goals.organizationId, goals.projectId, goals.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    unique("clarifications_goal_id_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.id,
    ),
    foreignKey({
      name: "clarifications_previous_revision_fk",
      columns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.previousClarificationId,
      ],
      foreignColumns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("clarifications_goal_thread_revision_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.threadId,
      table.revision,
    ),
    check(
      "clarifications_status_chk",
      sql`${table.status} IN ('open', 'answered', 'superseded')`,
    ),
    check(
      "clarifications_revision_chain_chk",
      sql`${table.revision} > 0 AND ((${table.revision} = 1 AND ${table.previousClarificationId} IS NULL) OR (${table.revision} > 1 AND ${table.previousClarificationId} IS NOT NULL))`,
    ),
    check(
      "clarifications_content_chk",
      sql`char_length(btrim(${table.question})) BETWEEN 1 AND 4000 AND ((${table.status} = 'open' AND ${table.answer} IS NULL) OR (${table.status} IN ('answered', 'superseded') AND char_length(btrim(${table.answer})) BETWEEN 1 AND 10000))`,
    ),
    check(
      "clarifications_source_goal_version_chk",
      sql`${table.sourceGoalVersion} > 0`,
    ),
  ],
);

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    decisionKey: uuid("decision_key").notNull(),
    revision: integer("revision").notNull(),
    previousDecisionId: uuid("previous_decision_id"),
    status: text("status").$type<DecisionStatus>().notNull(),
    subjectType: text("subject_type").$type<DecisionSubjectType>().notNull(),
    subjectId: uuid("subject_id").notNull(),
    subjectVersion: integer("subject_version").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "decisions_goal_organization_fk",
      columns: [table.organizationId, table.projectId, table.goalId],
      foreignColumns: [goals.organizationId, goals.projectId, goals.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    unique("decisions_goal_id_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.id,
    ),
    foreignKey({
      name: "decisions_previous_revision_fk",
      columns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.previousDecisionId,
      ],
      foreignColumns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("decisions_goal_key_revision_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.decisionKey,
      table.revision,
    ),
    check(
      "decisions_status_chk",
      sql`${table.status} IN ('proposed', 'approved', 'rejected', 'superseded')`,
    ),
    check(
      "decisions_subject_type_chk",
      sql`${table.subjectType} IN ('clarification', 'spec_revision', 'issue_plan')`,
    ),
    check(
      "decisions_revision_chain_chk",
      sql`${table.revision} > 0 AND ((${table.revision} = 1 AND ${table.previousDecisionId} IS NULL) OR (${table.revision} > 1 AND ${table.previousDecisionId} IS NOT NULL))`,
    ),
    check("decisions_subject_version_chk", sql`${table.subjectVersion} > 0`),
    check(
      "decisions_content_chk",
      sql`char_length(btrim(${table.outcome})) BETWEEN 1 AND 4000 AND char_length(btrim(${table.reason})) BETWEEN 1 AND 4000`,
    ),
  ],
);

export const specRevisions = pgTable(
  "spec_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    revision: integer("revision").notNull(),
    previousRevisionId: uuid("previous_revision_id"),
    status: text("status").$type<SpecRevisionStatus>().default("draft").notNull(),
    sourceGoalVersion: integer("source_goal_version").notNull(),
    artifactRef: text("artifact_ref").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
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
      name: "spec_revisions_goal_organization_fk",
      columns: [table.organizationId, table.projectId, table.goalId],
      foreignColumns: [goals.organizationId, goals.projectId, goals.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    unique("spec_revisions_goal_id_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.id,
    ),
    foreignKey({
      name: "spec_revisions_previous_revision_fk",
      columns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.previousRevisionId,
      ],
      foreignColumns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("spec_revisions_goal_revision_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.revision,
    ),
    check(
      "spec_revisions_status_chk",
      sql`${table.status} IN ('draft', 'in_review', 'approved', 'rejected', 'superseded')`,
    ),
    check(
      "spec_revisions_revision_chain_chk",
      sql`${table.revision} > 0 AND ((${table.revision} = 1 AND ${table.previousRevisionId} IS NULL) OR (${table.revision} > 1 AND ${table.previousRevisionId} IS NOT NULL))`,
    ),
    check(
      "spec_revisions_artifact_chk",
      sql`char_length(btrim(${table.artifactRef})) BETWEEN 1 AND 1000 AND ${table.artifactDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "spec_revisions_versions_chk",
      sql`${table.sourceGoalVersion} > 0 AND ${table.version} > 0`,
    ),
    check(
      "spec_revisions_timestamps_order_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    specRevisionId: uuid("spec_revision_id").notNull(),
    issueKey: text("issue_key").notNull(),
    revision: integer("revision").notNull(),
    previousIssueId: uuid("previous_issue_id"),
    status: text("status").$type<IssueStatus>().default("draft").notNull(),
    title: text("title").notNull(),
    bodyRef: text("body_ref").notNull(),
    bodyDigest: text("body_digest").notNull(),
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
      name: "issues_spec_revision_goal_fk",
      columns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.specRevisionId,
      ],
      foreignColumns: [
        specRevisions.organizationId,
        specRevisions.projectId,
        specRevisions.goalId,
        specRevisions.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    unique("issues_goal_id_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.id,
    ),
    foreignKey({
      name: "issues_previous_revision_fk",
      columns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.previousIssueId,
      ],
      foreignColumns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("issues_goal_key_revision_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.issueKey,
      table.revision,
    ),
    check(
      "issues_status_chk",
      sql`${table.status} IN ('draft', 'approved', 'ready', 'in_progress', 'blocked', 'completed', 'cancelled')`,
    ),
    check(
      "issues_revision_chain_chk",
      sql`${table.revision} > 0 AND ((${table.revision} = 1 AND ${table.previousIssueId} IS NULL) OR (${table.revision} > 1 AND ${table.previousIssueId} IS NOT NULL))`,
    ),
    check(
      "issues_identity_chk",
      sql`char_length(${table.issueKey}) BETWEEN 1 AND 64 AND ${table.issueKey} ~ '^[A-Z][A-Z0-9-]*$' AND char_length(btrim(${table.title})) BETWEEN 1 AND 300`,
    ),
    check(
      "issues_artifact_chk",
      sql`char_length(btrim(${table.bodyRef})) BETWEEN 1 AND 1000 AND ${table.bodyDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check("issues_version_positive_chk", sql`${table.version} > 0`),
    check(
      "issues_timestamps_order_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const issueDependencies = pgTable(
  "issue_dependencies",
  {
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    dependsOnIssueId: uuid("depends_on_issue_id").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "issue_dependencies_pk",
      columns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.issueId,
        table.dependsOnIssueId,
      ],
    }),
    foreignKey({
      name: "issue_dependencies_issue_goal_fk",
      columns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.issueId,
      ],
      foreignColumns: [
        issues.organizationId,
        issues.projectId,
        issues.goalId,
        issues.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "issue_dependencies_depends_on_goal_fk",
      columns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.dependsOnIssueId,
      ],
      foreignColumns: [
        issues.organizationId,
        issues.projectId,
        issues.goalId,
        issues.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    index("issue_dependencies_depends_on_idx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.dependsOnIssueId,
    ),
    check(
      "issue_dependencies_not_self_chk",
      sql`${table.issueId} <> ${table.dependsOnIssueId}`,
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
export type Clarification = typeof clarifications.$inferSelect;
export type NewClarification = typeof clarifications.$inferInsert;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type SpecRevision = typeof specRevisions.$inferSelect;
export type NewSpecRevision = typeof specRevisions.$inferInsert;
export type Issue = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
export type IssueDependency = typeof issueDependencies.$inferSelect;
export type NewIssueDependency = typeof issueDependencies.$inferInsert;

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
