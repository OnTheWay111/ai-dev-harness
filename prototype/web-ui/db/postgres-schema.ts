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
import {
  goalStatuses,
  issueStatuses,
  runStatuses,
  specRevisionStatuses,
} from "../app/control-plane/domain/state-machines.ts";
import type {
  GoalStatus,
  IssueStatus,
  RunStatus,
  SpecRevisionStatus,
} from "../app/control-plane/domain/state-machines.ts";
import type { Role } from "../app/auth/role-binding-repository.ts";

export {
  goalStatuses,
  issueStatuses,
  runStatuses,
  specRevisionStatuses,
};
export type { GoalStatus, IssueStatus, RunStatus, SpecRevisionStatus };

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

export const evidenceKinds = [
  "artifact",
  "log",
  "test",
  "review",
  "commit",
  "push",
] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];

export const outboxStatuses = ["pending", "published", "failed"] as const;
export type OutboxStatus = (typeof outboxStatuses)[number];

export const idempotencyStatuses = [
  "in_progress",
  "completed",
  "failed",
] as const;
export type IdempotencyStatus = (typeof idempotencyStatuses)[number];

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

export const roleBindings = pgTable(
  "role_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id"),
    actorId: text("actor_id").notNull(),
    role: text("role").$type<Role>().notNull(),
    assignedByActorId: text("assigned_by_actor_id").notNull(),
    reason: text("reason").notNull(),
    requestId: text("request_id").notNull(),
    version: integer("version").default(1).notNull(),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
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
      name: "role_bindings_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "role_bindings_project_organization_fk",
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("role_bindings_active_organization_uidx")
      .on(table.organizationId, table.actorId, table.role)
      .where(sql`${table.projectId} IS NULL AND ${table.revokedAt} IS NULL`),
    uniqueIndex("role_bindings_active_project_uidx")
      .on(table.organizationId, table.projectId, table.actorId, table.role)
      .where(sql`${table.projectId} IS NOT NULL AND ${table.revokedAt} IS NULL`),
    index("role_bindings_actor_scope_idx").on(
      table.actorId,
      table.organizationId,
      table.projectId,
    ),
    check(
      "role_bindings_scope_chk",
      sql`(${table.role} = 'organization_owner' AND ${table.projectId} IS NULL) OR (${table.role} = 'project_admin' AND ${table.projectId} IS NOT NULL) OR ${table.role} IN ('approver', 'operator', 'viewer')`,
    ),
    check(
      "role_bindings_identity_chk",
      sql`char_length(btrim(${table.actorId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.assignedByActorId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.reason})) BETWEEN 1 AND 4000 AND char_length(btrim(${table.requestId})) BETWEEN 1 AND 200 AND ${table.version} > 0`,
    ),
    check(
      "role_bindings_lifecycle_chk",
      sql`${table.updatedAt} >= ${table.createdAt} AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt})`,
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
    nonGoals: jsonb("non_goals").$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    constraints: jsonb("constraints").$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    status: text("status").$type<GoalStatus>().default("draft").notNull(),
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
    check(
      "goals_contract_lists_chk",
      sql`jsonb_typeof(${table.nonGoals}) = 'array' AND jsonb_array_length(${table.nonGoals}) <= 50 AND jsonb_typeof(${table.constraints}) = 'array' AND jsonb_array_length(${table.constraints}) <= 50`,
    ),
    check(
      "goals_status_chk",
      sql`${table.status} IN ('draft', 'clarifying', 'planning', 'approved', 'executing', 'verifying', 'completed', 'cancelled')`,
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

export const clarificationRounds = pgTable(
  "clarification_rounds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    roundNumber: integer("round_number").notNull(),
    previousRoundId: uuid("previous_round_id"),
    regeneratedFromRoundId: uuid("regenerated_from_round_id"),
    sourceGoalVersion: integer("source_goal_version").notNull(),
    plannerRunId: text("planner_run_id").notNull(),
    knownFacts: jsonb("known_facts").notNull(),
    uncertainties: jsonb("uncertainties").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "clarification_rounds_goal_organization_fk",
      columns: [table.organizationId, table.projectId, table.goalId],
      foreignColumns: [goals.organizationId, goals.projectId, goals.id],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("clarification_rounds_goal_id_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.id,
    ),
    foreignKey({
      name: "clarification_rounds_previous_fk",
      columns: [table.organizationId, table.projectId, table.goalId, table.previousRoundId],
      foreignColumns: [table.organizationId, table.projectId, table.goalId, table.id],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "clarification_rounds_regenerated_from_fk",
      columns: [table.organizationId, table.projectId, table.goalId, table.regeneratedFromRoundId],
      foreignColumns: [table.organizationId, table.projectId, table.goalId, table.id],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("clarification_rounds_goal_number_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.roundNumber,
    ),
    check("clarification_rounds_number_chk", sql`${table.roundNumber} > 0`),
    check("clarification_rounds_goal_version_chk", sql`${table.sourceGoalVersion} > 0`),
    check(
      "clarification_rounds_chain_chk",
      sql`(${table.roundNumber} = 1 AND ${table.previousRoundId} IS NULL AND ${table.regeneratedFromRoundId} IS NULL) OR (${table.roundNumber} > 1 AND ${table.previousRoundId} IS NOT NULL AND ${table.regeneratedFromRoundId} IS NOT NULL)`,
    ),
    check("clarification_rounds_actor_chk", sql`char_length(btrim(${table.actorId})) BETWEEN 1 AND 200`),
    check("clarification_rounds_reason_chk", sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 4000`),
  ],
);

export const clarifications = pgTable(
  "clarifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    roundId: uuid("round_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    revision: integer("revision").notNull(),
    previousClarificationId: uuid("previous_clarification_id"),
    status: text("status").$type<ClarificationStatus>().notNull(),
    question: text("question").notNull(),
    plannerQuestionId: text("planner_question_id").notNull(),
    rationale: text("rationale").notNull(),
    blockingLevel: text("blocking_level").notNull(),
    answerType: text("answer_type").notNull(),
    suggestedOptions: jsonb("suggested_options").notNull(),
    answer: text("answer"),
    sourceGoalVersion: integer("source_goal_version").notNull(),
    actorId: text("actor_id").notNull(),
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
      name: "clarifications_round_fk",
      columns: [table.organizationId, table.projectId, table.goalId, table.roundId],
      foreignColumns: [
        clarificationRounds.organizationId,
        clarificationRounds.projectId,
        clarificationRounds.goalId,
        clarificationRounds.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
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
    check("clarifications_metadata_chk", sql`char_length(btrim(${table.plannerQuestionId})) BETWEEN 1 AND 64 AND char_length(btrim(${table.rationale})) BETWEEN 1 AND 4000 AND ${table.blockingLevel} IN ('blocker', 'high', 'medium', 'low') AND ${table.answerType} IN ('single_choice', 'multiple_choice', 'boolean', 'text', 'number')`),
    check("clarifications_actor_chk", sql`char_length(btrim(${table.actorId})) BETWEEN 1 AND 200`),
    check("clarifications_reason_chk", sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 4000`),
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
    actorId: text("actor_id").notNull(),
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
      sql`char_length(btrim(${table.outcome})) BETWEEN 1 AND 4000 AND char_length(btrim(${table.actorId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.reason})) BETWEEN 1 AND 4000`,
    ),
  ],
);

export const classificationPolicyRevisions = pgTable(
  "classification_policy_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    policyKey: text("policy_key").notNull(),
    revision: integer("revision").notNull(),
    previousPolicyRevisionId: uuid("previous_policy_revision_id"),
    schemaVersion: text("schema_version").notNull(),
    digest: text("digest").notNull(),
    definition: jsonb("definition").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "classification_policy_revisions_previous_fk",
      columns: [table.previousPolicyRevisionId],
      foreignColumns: [table.id],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("classification_policy_revisions_key_revision_uidx").on(
      table.policyKey, table.revision,
    ),
    uniqueIndex("classification_policy_revisions_digest_uidx").on(table.digest),
    check("classification_policy_revisions_revision_chk", sql`${table.revision} > 0 AND ((${table.revision} = 1 AND ${table.previousPolicyRevisionId} IS NULL) OR (${table.revision} > 1 AND ${table.previousPolicyRevisionId} IS NOT NULL))`),
    check("classification_policy_revisions_key_chk", sql`char_length(btrim(${table.policyKey})) BETWEEN 1 AND 100`),
    check("classification_policy_revisions_schema_chk", sql`char_length(btrim(${table.schemaVersion})) BETWEEN 1 AND 100`),
    check("classification_policy_revisions_digest_chk", sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
    check("classification_policy_revisions_actor_chk", sql`char_length(btrim(${table.actorId})) BETWEEN 1 AND 200`),
    check("classification_policy_revisions_reason_chk", sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 4000`),
  ],
);

export const classifications = pgTable(
  "classifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    revision: integer("revision").notNull(),
    previousClassificationId: uuid("previous_classification_id"),
    sourceGoalVersion: integer("source_goal_version").notNull(),
    policyRevisionId: uuid("policy_revision_id").notNull(),
    size: text("size").notNull(),
    risk: text("risk").notNull(),
    sizeScore: integer("size_score").notNull(),
    riskScore: integer("risk_score").notNull(),
    matchedFactors: jsonb("matched_factors").notNull(),
    requiredArtifacts: jsonb("required_artifacts").notNull(),
    requiredApproverRoles: jsonb("required_approver_roles").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "classifications_goal_organization_fk",
      columns: [table.organizationId, table.projectId, table.goalId],
      foreignColumns: [goals.organizationId, goals.projectId, goals.id],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("classifications_goal_id_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.id,
    ),
    foreignKey({
      name: "classifications_previous_fk",
      columns: [table.organizationId, table.projectId, table.goalId, table.previousClassificationId],
      foreignColumns: [table.organizationId, table.projectId, table.goalId, table.id],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "classifications_policy_revision_fk",
      columns: [table.policyRevisionId],
      foreignColumns: [classificationPolicyRevisions.id],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("classifications_goal_revision_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.revision,
    ),
    check("classifications_revision_chain_chk", sql`${table.revision} > 0 AND ((${table.revision} = 1 AND ${table.previousClassificationId} IS NULL) OR (${table.revision} > 1 AND ${table.previousClassificationId} IS NOT NULL))`),
    check("classifications_goal_version_chk", sql`${table.sourceGoalVersion} > 0`),
    check("classifications_size_chk", sql`${table.size} IN ('S','M','L','XL')`),
    check("classifications_risk_chk", sql`${table.risk} IN ('low','medium','high')`),
    check("classifications_scores_chk", sql`${table.sizeScore} >= 0 AND ${table.riskScore} >= 0`),
    check("classifications_actor_chk", sql`char_length(btrim(${table.actorId})) BETWEEN 1 AND 200`),
    check("classifications_reason_chk", sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 4000`),
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
    artifactMediaType: text("artifact_media_type")
      .$type<"application/json">()
      .default("application/json")
      .notNull(),
    artifactSizeBytes: bigint("artifact_size_bytes", { mode: "number" })
      .default(0)
      .notNull(),
    plannerRunId: text("planner_run_id").default("legacy-migration").notNull(),
    plannerConfiguration: jsonb("planner_configuration")
      .$type<import("../app/control-plane/domain/spec-artifact.ts").PlannerConfiguration>()
      .default(sql`'{"adapter":"legacy","modelProfile":"unknown","schemaVersion":"spec-bundle.v1"}'::jsonb`)
      .notNull(),
    overdesignPolicyRevision: text("overdesign_policy_revision")
      .default("overdesign-policy.v1")
      .notNull(),
    overdesignReview: jsonb("overdesign_review")
      .$type<import("../app/control-plane/domain/overdesign-review.ts").OverdesignReview>()
      .default(sql`'{"schemaVersion":"overdesign-review.v1","policyRevision":"overdesign-policy.v1","counts":{"Required":0,"Helpful":0,"Speculative":0},"items":[]}'::jsonb`)
      .notNull(),
    generatedAt: timestamp("generated_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
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
      sql`char_length(btrim(${table.artifactRef})) BETWEEN 1 AND 1000 AND ${table.artifactDigest} ~ '^[0-9a-f]{64}$' AND ${table.artifactMediaType} = 'application/json' AND ${table.artifactSizeBytes} >= 0`,
    ),
    check(
      "spec_revisions_planner_metadata_chk",
      sql`char_length(btrim(${table.plannerRunId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.overdesignPolicyRevision})) BETWEEN 1 AND 100 AND ${table.generatedAt} >= ${table.createdAt}`,
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

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").$type<RunStatus>().default("queued").notNull(),
    requestId: text("request_id").notNull(),
    version: integer("version").default(1).notNull(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }),
    finishedAt: timestamp("finished_at", {
      withTimezone: true,
      mode: "date",
    }),
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
      name: "runs_issue_goal_fk",
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
    unique("runs_issue_id_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.issueId,
      table.id,
    ),
    uniqueIndex("runs_issue_attempt_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.issueId,
      table.attempt,
    ),
    index("runs_status_updated_idx").on(
      table.organizationId,
      table.status,
      table.updatedAt,
    ),
    check("runs_attempt_positive_chk", sql`${table.attempt} > 0`),
    check(
      "runs_status_chk",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "runs_lifecycle_chk",
      sql`(${table.status} = 'queued' AND ${table.startedAt} IS NULL AND ${table.finishedAt} IS NULL) OR (${table.status} = 'running' AND ${table.startedAt} IS NOT NULL AND ${table.finishedAt} IS NULL) OR (${table.status} IN ('succeeded', 'failed') AND ${table.startedAt} IS NOT NULL AND ${table.finishedAt} >= ${table.startedAt}) OR (${table.status} = 'cancelled' AND ${table.finishedAt} IS NOT NULL AND (${table.startedAt} IS NULL OR ${table.finishedAt} >= ${table.startedAt}))`,
    ),
    check(
      "runs_identity_version_chk",
      sql`char_length(btrim(${table.requestId})) BETWEEN 1 AND 200 AND ${table.version} > 0`,
    ),
    check(
      "runs_timestamps_order_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    runId: uuid("run_id").notNull(),
    kind: text("kind").$type<EvidenceKind>().notNull(),
    artifactRef: text("artifact_ref").notNull(),
    digest: text("digest").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    retentionUntil: timestamp("retention_until", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "evidence_run_issue_fk",
      columns: [
        table.organizationId,
        table.projectId,
        table.goalId,
        table.issueId,
        table.runId,
      ],
      foreignColumns: [
        runs.organizationId,
        runs.projectId,
        runs.goalId,
        runs.issueId,
        runs.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("evidence_run_kind_digest_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
      table.runId,
      table.kind,
      table.digest,
    ),
    index("evidence_retention_idx").on(
      table.organizationId,
      table.retentionUntil,
    ),
    check(
      "evidence_kind_chk",
      sql`${table.kind} IN ('artifact', 'log', 'test', 'review', 'commit', 'push')`,
    ),
    check("evidence_digest_chk", sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
    check(
      "evidence_metadata_chk",
      sql`char_length(btrim(${table.artifactRef})) BETWEEN 1 AND 1000 AND char_length(btrim(${table.mediaType})) BETWEEN 1 AND 200 AND ${table.sizeBytes} >= 0 AND ${table.retentionUntil} > ${table.createdAt}`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id"),
    goalId: uuid("goal_id"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    entityVersion: integer("entity_version").notNull(),
    reason: text("reason").notNull(),
    requestId: text("request_id").notNull(),
    detailsRef: text("details_ref"),
    detailsDigest: text("details_digest"),
    retentionUntil: timestamp("retention_until", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "audit_events_project_organization_fk",
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "audit_events_goal_organization_fk",
      columns: [table.organizationId, table.projectId, table.goalId],
      foreignColumns: [goals.organizationId, goals.projectId, goals.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    index("audit_events_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("audit_events_entity_idx").on(
      table.organizationId,
      table.entityType,
      table.entityId,
      table.entityVersion,
    ),
    check(
      "audit_events_scope_chk",
      sql`${table.goalId} IS NULL OR ${table.projectId} IS NOT NULL`,
    ),
    check(
      "audit_events_identity_chk",
      sql`char_length(btrim(${table.actorId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.action})) BETWEEN 1 AND 200 AND char_length(btrim(${table.entityType})) BETWEEN 1 AND 100 AND ${table.entityVersion} > 0 AND char_length(btrim(${table.reason})) BETWEEN 1 AND 4000 AND char_length(btrim(${table.requestId})) BETWEEN 1 AND 200`,
    ),
    check(
      "audit_events_details_chk",
      sql`((${table.detailsRef} IS NULL AND ${table.detailsDigest} IS NULL) OR (char_length(btrim(${table.detailsRef})) BETWEEN 1 AND 1000 AND ${table.detailsDigest} ~ '^[0-9a-f]{64}$')) AND ${table.retentionUntil} > ${table.createdAt}`,
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    eventType: text("event_type").notNull(),
    deduplicationKey: text("deduplication_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<OutboxStatus>().default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    availableAt: timestamp("available_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastErrorRef: text("last_error_ref"),
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
      name: "outbox_events_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("outbox_events_organization_dedupe_uidx").on(
      table.organizationId,
      table.deduplicationKey,
    ),
    uniqueIndex("outbox_events_aggregate_version_uidx").on(
      table.organizationId,
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion,
      table.eventType,
    ),
    index("outbox_events_dispatch_idx").on(
      table.status,
      table.availableAt,
      table.createdAt,
    ),
    check(
      "outbox_events_status_chk",
      sql`${table.status} IN ('pending', 'published', 'failed')`,
    ),
    check(
      "outbox_events_state_chk",
      sql`${table.aggregateVersion} > 0 AND ${table.attempts} >= 0 AND ((${table.status} = 'published' AND ${table.publishedAt} IS NOT NULL) OR (${table.status} <> 'published' AND ${table.publishedAt} IS NULL))`,
    ),
    check(
      "outbox_events_identity_chk",
      sql`char_length(btrim(${table.aggregateType})) BETWEEN 1 AND 100 AND char_length(btrim(${table.eventType})) BETWEEN 1 AND 200 AND char_length(btrim(${table.deduplicationKey})) BETWEEN 1 AND 300 AND (${table.lastErrorRef} IS NULL OR char_length(btrim(${table.lastErrorRef})) BETWEEN 1 AND 1000)`,
    ),
    check(
      "outbox_events_timestamps_order_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    actorId: text("actor_id").notNull(),
    endpoint: text("endpoint").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status")
      .$type<IdempotencyStatus>()
      .default("in_progress")
      .notNull(),
    responseStatus: integer("response_status"),
    responseRef: text("response_ref"),
    responseDigest: text("response_digest"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
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
      name: "idempotency_records_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("idempotency_records_scope_key_uidx").on(
      table.organizationId,
      table.actorId,
      table.endpoint,
      table.key,
    ),
    index("idempotency_records_expiry_idx").on(
      table.organizationId,
      table.expiresAt,
    ),
    check(
      "idempotency_records_status_chk",
      sql`${table.status} IN ('in_progress', 'completed', 'failed')`,
    ),
    check(
      "idempotency_records_identity_chk",
      sql`char_length(btrim(${table.actorId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.endpoint})) BETWEEN 1 AND 300 AND char_length(${table.key}) BETWEEN 1 AND 200 AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "idempotency_records_response_chk",
      sql`(${table.status} = 'in_progress' AND ${table.responseStatus} IS NULL AND ${table.responseRef} IS NULL AND ${table.responseDigest} IS NULL) OR (${table.status} IN ('completed', 'failed') AND ${table.responseStatus} BETWEEN 100 AND 599 AND char_length(btrim(${table.responseRef})) BETWEEN 1 AND 1000 AND ${table.responseDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "idempotency_records_expiry_chk",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type RoleBindingRecord = typeof roleBindings.$inferSelect;
export type NewRoleBindingRecord = typeof roleBindings.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
export type AcceptanceCriterion = typeof acceptanceCriteria.$inferSelect;
export type NewAcceptanceCriterion = typeof acceptanceCriteria.$inferInsert;
export type Clarification = typeof clarifications.$inferSelect;
export type NewClarification = typeof clarifications.$inferInsert;
export type ClarificationRound = typeof clarificationRounds.$inferSelect;
export type NewClarificationRound = typeof clarificationRounds.$inferInsert;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type ClassificationPolicyRevision = typeof classificationPolicyRevisions.$inferSelect;
export type NewClassificationPolicyRevision = typeof classificationPolicyRevisions.$inferInsert;
export type Classification = typeof classifications.$inferSelect;
export type NewClassification = typeof classifications.$inferInsert;
export type SpecRevision = typeof specRevisions.$inferSelect;
export type NewSpecRevision = typeof specRevisions.$inferInsert;
export type Issue = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
export type IssueDependency = typeof issueDependencies.$inferSelect;
export type NewIssueDependency = typeof issueDependencies.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;

export const workbenchSnapshots = pgTable(
  "workbench_snapshots",
  {
    scopeId: text("scope_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
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
  },
  (table) => [
    primaryKey({
      columns: [table.scopeId, table.organizationId, table.projectId],
    }),
    index("workbench_snapshots_visibility_idx").on(
      table.scopeId,
      table.organizationId,
      table.projectId,
    ),
  ],
);

export const workbenchTasks = pgTable(
  "workbench_tasks",
  {
    scopeId: text("scope_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
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
    primaryKey({
      columns: [
        table.scopeId,
        table.organizationId,
        table.projectId,
        table.taskId,
      ],
    }),
    index("workbench_tasks_scope_rank_idx").on(
      table.scopeId,
      table.organizationId,
      table.projectId,
      table.rank,
    ),
    index("workbench_tasks_scope_goal_idx").on(
      table.scopeId,
      table.organizationId,
      table.projectId,
      table.goalId,
    ),
    index("workbench_tasks_scope_stage_idx").on(
      table.scopeId,
      table.organizationId,
      table.projectId,
      table.stage,
    ),
    index("workbench_tasks_scope_attention_idx").on(
      table.scopeId,
      table.organizationId,
      table.projectId,
      table.attentionRequired,
    ),
  ],
);
