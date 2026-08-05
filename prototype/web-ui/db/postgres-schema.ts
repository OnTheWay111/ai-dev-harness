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
import {
  artifactKinds,
  type ArtifactKind,
} from "../app/control-plane/domain/artifact-evidence.ts";
import {
  deliveryCandidateStates,
  type DeliveryCandidateState,
} from "../app/control-plane/domain/delivery.ts";
import {
  gitCredentialScopes,
  pushModes,
  type GitCredentialScope,
  type PushMode,
} from "../app/control-plane/domain/delivery-policy.ts";
import {
  reviewVerdicts,
  type ReviewFinding,
  type ReviewVerdict,
} from "../app/control-plane/domain/review.ts";
import type {
  ArtifactRetentionPolicy,
} from "../app/control-plane/ports/object-store-port.ts";
import type {
  AcceptanceVerificationEntry,
  VerificationPlanCompilation,
} from "../app/control-plane/domain/acceptance-verification.ts";
import type {
  DeterministicVerificationResult,
  GoalVerificationVerdict,
  GoalVerifierOutput,
} from "../app/control-plane/domain/goal-verification.ts";
import type {
  GapRemediationReceipt,
  VerificationGap,
} from "../app/control-plane/domain/verification-gap.ts";
import type {
  DeliveryHumanAcceptance,
  DeliveryIssueRun,
  DeliveryKnownRisk,
  DeliveryReportAcceptance,
  DeliveryReportStatus,
} from "../app/control-plane/domain/delivery-report.ts";

export {
  artifactKinds,
  deliveryCandidateStates,
  gitCredentialScopes,
  pushModes,
  reviewVerdicts,
};

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

export const issuePlanStatuses = [
  "draft",
  "approved",
  "rejected",
  "superseded",
] as const;
export type IssuePlanStatus = (typeof issuePlanStatuses)[number];

export const queueProjectionStatuses = ["completed", "failed"] as const;
export type QueueProjectionStatus = (typeof queueProjectionStatuses)[number];

export const schedulerJobStates = [
  "pending",
  "claimed",
  "starting",
  "running",
  "retry_wait",
  "reconciling",
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
] as const;
export type SchedulerJobState = (typeof schedulerJobStates)[number];

export const executionNodeStatuses = ["online", "draining", "offline"] as const;
export type ExecutionNodeStatus = (typeof executionNodeStatuses)[number];

export const executionLeaseStatuses = ["active", "released", "expired"] as const;
export type ExecutionLeaseStatus = (typeof executionLeaseStatuses)[number];

export const externalEventProcessingStatuses = [
  "pending",
  "applied",
  "duplicate",
  "gap",
  "terminal_ignored",
  "failed",
] as const;
export type ExternalEventProcessingStatus =
  (typeof externalEventProcessingStatuses)[number];

export const executionControlStates = [
  "active",
  "paused",
  "draining",
  "stopped",
] as const;
export type ExecutionControlState = (typeof executionControlStates)[number];

export const taskActionReceiptStatuses = [
  "accepted",
  "running",
  "completed",
  "failed",
] as const;
export type TaskActionReceiptStatus =
  (typeof taskActionReceiptStatuses)[number];

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
    requestId: text("request_id").default("legacy-migration").notNull(),
    policyRevision: text("policy_revision").default("legacy-policy").notNull(),
    affectedItemIds: jsonb("affected_item_ids").$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    decisionPayload: jsonb("decision_payload")
      .$type<Readonly<Record<string, unknown>>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
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
      sql`char_length(btrim(${table.outcome})) BETWEEN 1 AND 4000 AND char_length(btrim(${table.actorId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.reason})) BETWEEN 1 AND 4000 AND char_length(btrim(${table.requestId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.policyRevision})) BETWEEN 1 AND 100`,
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

export const issuePlanRevisions = pgTable(
  "issue_plan_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    specRevisionId: uuid("spec_revision_id").notNull(),
    revision: integer("revision").notNull(),
    previousPlanId: uuid("previous_plan_id"),
    status: text("status").$type<IssuePlanStatus>().default("draft").notNull(),
    sourceSpecVersion: integer("source_spec_version").notNull(),
    sourceSpecDigest: text("source_spec_digest").notNull(),
    planData: jsonb("plan_data")
      .$type<import("../app/control-plane/domain/issue-plan.ts").IssuePlan>()
      .notNull(),
    digest: text("digest").notNull(),
    plannerRunId: text("planner_run_id").notNull(),
    plannerConfiguration: jsonb("planner_configuration")
      .$type<import("../app/control-plane/domain/issue-plan.ts").IssuePlannerConfiguration>()
      .notNull(),
    compilerPolicyRevision: text("compiler_policy_revision").notNull(),
    conflictPolicyRevision: text("conflict_policy_revision").notNull(),
    modelRouterPolicyRevision: text("model_router_policy_revision").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true, mode: "date" })
      .notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "issue_plan_revisions_spec_revision_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.specRevisionId,
      ],
      foreignColumns: [
        specRevisions.organizationId, specRevisions.projectId,
        specRevisions.goalId, specRevisions.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("issue_plan_revisions_goal_id_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.id,
    ),
    foreignKey({
      name: "issue_plan_revisions_previous_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.previousPlanId,
      ],
      foreignColumns: [
        table.organizationId, table.projectId, table.goalId, table.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("issue_plan_revisions_goal_revision_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.revision,
    ),
    check(
      "issue_plan_revisions_chain_chk",
      sql`${table.revision} > 0 AND ((${table.revision} = 1 AND ${table.previousPlanId} IS NULL) OR (${table.revision} > 1 AND ${table.previousPlanId} IS NOT NULL))`,
    ),
    check("issue_plan_revisions_status_chk", sql`${table.status} IN ('draft','approved','rejected','superseded')`),
    check("issue_plan_revisions_source_chk", sql`${table.sourceSpecVersion} > 0 AND ${table.sourceSpecDigest} ~ '^[0-9a-f]{64}$'`),
    check("issue_plan_revisions_digest_chk", sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
    check(
      "issue_plan_revisions_metadata_chk",
      sql`char_length(btrim(${table.plannerRunId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.compilerPolicyRevision})) BETWEEN 1 AND 100 AND char_length(btrim(${table.conflictPolicyRevision})) BETWEEN 1 AND 100 AND char_length(btrim(${table.modelRouterPolicyRevision})) BETWEEN 1 AND 100`,
    ),
    check("issue_plan_revisions_version_positive_chk", sql`${table.version} > 0`),
    check("issue_plan_revisions_timestamps_order_chk", sql`${table.generatedAt} >= ${table.createdAt} AND ${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const modelRecommendations = pgTable(
  "model_recommendations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    issuePlanId: uuid("issue_plan_id").notNull(),
    issueKey: text("issue_key").notNull(),
    capabilityTier: text("capability_tier")
      .$type<import("../app/control-plane/domain/model-router.ts").CapabilityTier>()
      .notNull(),
    reasoningEffort: text("reasoning_effort")
      .$type<import("../app/control-plane/domain/model-router.ts").ReasoningEffort>()
      .notNull(),
    factors: jsonb("factors")
      .$type<import("../app/control-plane/domain/model-router.ts").ModelRoutingFactors>()
      .notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull(),
    override: jsonb("override")
      .$type<import("../app/control-plane/domain/model-router.ts").ModelRouteOverride | null>(),
    policyRevision: text("policy_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "model_recommendations_plan_fk",
      columns: [table.organizationId, table.projectId, table.goalId, table.issuePlanId],
      foreignColumns: [
        issuePlanRevisions.organizationId, issuePlanRevisions.projectId,
        issuePlanRevisions.goalId, issuePlanRevisions.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("model_recommendations_plan_issue_uidx").on(
      table.organizationId, table.projectId, table.goalId,
      table.issuePlanId, table.issueKey,
    ),
    check("model_recommendations_issue_key_chk", sql`char_length(${table.issueKey}) BETWEEN 1 AND 64 AND ${table.issueKey} ~ '^[A-Z][A-Z0-9-]*$'`),
    check("model_recommendations_capability_chk", sql`${table.capabilityTier} IN ('cost_optimized','general_coding','advanced_coding','frontier')`),
    check("model_recommendations_effort_chk", sql`${table.reasoningEffort} IN ('low','medium','high','highest')`),
    check("model_recommendations_policy_chk", sql`char_length(btrim(${table.policyRevision})) BETWEEN 1 AND 100`),
  ],
);

export const executionWaves = pgTable(
  "execution_waves",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    issuePlanId: uuid("issue_plan_id").notNull(),
    waveNumber: integer("wave_number").notNull(),
    issueKeys: jsonb("issue_keys").$type<string[]>().notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "execution_waves_plan_fk",
      columns: [table.organizationId, table.projectId, table.goalId, table.issuePlanId],
      foreignColumns: [
        issuePlanRevisions.organizationId, issuePlanRevisions.projectId,
        issuePlanRevisions.goalId, issuePlanRevisions.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("execution_waves_plan_number_uidx").on(
      table.organizationId, table.projectId, table.goalId,
      table.issuePlanId, table.waveNumber,
    ),
    check("execution_waves_number_chk", sql`${table.waveNumber} > 0`),
    check("execution_waves_issue_keys_chk", sql`jsonb_typeof(${table.issueKeys}) = 'array' AND jsonb_array_length(${table.issueKeys}) > 0`),
    check("execution_waves_reasons_chk", sql`jsonb_typeof(${table.reasons}) = 'array'`),
  ],
);

export const queueProjections = pgTable(
  "queue_projections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    issuePlanId: uuid("issue_plan_id").notNull(),
    planDigest: text("plan_digest").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestId: text("request_id").notNull(),
    externalImportId: text("external_import_id").notNull(),
    status: text("status").$type<QueueProjectionStatus>().notNull(),
    receipt: jsonb("receipt")
      .$type<import("../app/control-plane/ports/queue-projection-port.ts").QueueProjectionReceipt>()
      .notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "queue_projections_plan_fk",
      columns: [table.organizationId, table.projectId, table.goalId, table.issuePlanId],
      foreignColumns: [
        issuePlanRevisions.organizationId, issuePlanRevisions.projectId,
        issuePlanRevisions.goalId, issuePlanRevisions.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("queue_projections_idempotency_uidx").on(
      table.organizationId, table.idempotencyKey,
    ),
    uniqueIndex("queue_projections_plan_digest_uidx").on(
      table.organizationId, table.projectId, table.goalId,
      table.issuePlanId, table.planDigest,
    ),
    check("queue_projections_digest_chk", sql`${table.planDigest} ~ '^[0-9a-f]{64}$'`),
    check("queue_projections_status_chk", sql`${table.status} IN ('completed','failed')`),
    check("queue_projections_identity_chk", sql`char_length(btrim(${table.idempotencyKey})) BETWEEN 1 AND 200 AND char_length(btrim(${table.requestId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.externalImportId})) BETWEEN 1 AND 200`),
    check("queue_projections_version_positive_chk", sql`${table.version} > 0`),
    check("queue_projections_timestamps_order_chk", sql`${table.updatedAt} >= ${table.createdAt}`),
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
    unique("runs_goal_id_uidx").on(
      table.organizationId,
      table.projectId,
      table.goalId,
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

export const executionNodes = pgTable(
  "execution_nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>()
      .default(sql`'[]'::jsonb`).notNull(),
    maxConcurrentRuns: integer("max_concurrent_runs").notNull(),
    status: text("status").$type<ExecutionNodeStatus>().default("offline").notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: "date" }).notNull(),
    offlineAfter: timestamp("offline_after", { withTimezone: true, mode: "date" }).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("execution_nodes_name_uidx").on(table.name),
    index("execution_nodes_provider_status_idx").on(table.provider, table.status),
    check(
      "execution_nodes_identity_chk",
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND 200 AND char_length(btrim(${table.provider})) BETWEEN 1 AND 100`,
    ),
    check(
      "execution_nodes_capabilities_chk",
      sql`jsonb_typeof(${table.capabilities}) = 'array'`,
    ),
    check(
      "execution_nodes_capacity_chk",
      sql`${table.maxConcurrentRuns} > 0 AND ${table.maxConcurrentRuns} <= 1000`,
    ),
    check(
      "execution_nodes_status_chk",
      sql`${table.status} IN ('online','draining','offline')`,
    ),
    check(
      "execution_nodes_liveness_chk",
      sql`${table.offlineAfter} > ${table.heartbeatAt}`,
    ),
    check("execution_nodes_version_chk", sql`${table.version} > 0`),
    check(
      "execution_nodes_timestamps_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const schedulerJobs = pgTable(
  "scheduler_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    runId: uuid("run_id").notNull(),
    externalTaskId: text("external_task_id").notNull(),
    requiredCapability: text("required_capability")
      .$type<import("../app/control-plane/domain/model-router.ts").CapabilityTier>()
      .default("general_coding").notNull(),
    state: text("state").$type<SchedulerJobState>().default("pending").notNull(),
    phase: text("phase").default("queued").notNull(),
    priority: integer("priority").default(100).notNull(),
    attempt: integer("attempt").default(1).notNull(),
    maxAttempts: integer("max_attempts").default(1).notNull(),
    budget: jsonb("budget").$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true, mode: "date" }).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
    externalRunId: text("external_run_id"),
    nodeId: uuid("node_id"),
    leaseTokenDigest: text("lease_token_digest"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: "date" }),
    lastEventSequence: integer("last_event_sequence").default(0).notNull(),
    reconciliationRequired: boolean("reconciliation_required").default(false).notNull(),
    failureCode: text("failure_code"),
    failureReason: text("failure_reason"),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "scheduler_jobs_run_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.issueId,
        table.runId,
      ],
      foreignColumns: [
        runs.organizationId, runs.projectId, runs.goalId, runs.issueId, runs.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "scheduler_jobs_node_fk",
      columns: [table.nodeId],
      foreignColumns: [executionNodes.id],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("scheduler_jobs_scope_id_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.id,
    ),
    uniqueIndex("scheduler_jobs_run_uidx").on(table.runId),
    uniqueIndex("scheduler_jobs_external_run_uidx").on(table.externalRunId),
    index("scheduler_jobs_claim_idx").on(
      table.state, table.nextAttemptAt, table.priority, table.createdAt,
    ),
    index("scheduler_jobs_reconcile_idx").on(
      table.reconciliationRequired, table.state, table.updatedAt,
    ),
    check(
      "scheduler_jobs_state_chk",
      sql`${table.state} IN ('pending','claimed','starting','running','retry_wait','reconciling','succeeded','failed','cancelled','blocked')`,
    ),
    check(
      "scheduler_jobs_attempt_chk",
      sql`${table.attempt} > 0 AND ${table.maxAttempts} >= ${table.attempt}`,
    ),
    check(
      "scheduler_jobs_sequence_chk",
      sql`${table.lastEventSequence} >= 0`,
    ),
    check(
      "scheduler_jobs_identity_chk",
      sql`char_length(btrim(${table.externalTaskId})) BETWEEN 1 AND 128 AND (${table.externalRunId} IS NULL OR char_length(btrim(${table.externalRunId})) BETWEEN 1 AND 128)`,
    ),
    check(
      "scheduler_jobs_capability_chk",
      sql`${table.requiredCapability} IN ('cost_optimized','general_coding','advanced_coding','frontier')`,
    ),
    check("scheduler_jobs_version_chk", sql`${table.version} > 0`),
    check(
      "scheduler_jobs_timestamps_chk",
      sql`${table.deadlineAt} > ${table.createdAt} AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const executionLeases = pgTable(
  "execution_leases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    ownerId: text("owner_id").notNull(),
    tokenDigest: text("token_digest").notNull(),
    status: text("status").$type<ExecutionLeaseStatus>().default("active").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true, mode: "date" }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    version: integer("version").default(1).notNull(),
  },
  (table) => [
    foreignKey({
      name: "execution_leases_run_fk",
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "execution_leases_node_fk",
      columns: [table.nodeId],
      foreignColumns: [executionNodes.id],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("execution_leases_active_run_uidx")
      .on(table.runId)
      .where(sql`${table.status} = 'active'`),
    index("execution_leases_active_node_idx").on(table.nodeId, table.status, table.expiresAt),
    check(
      "execution_leases_status_chk",
      sql`${table.status} IN ('active','released','expired')`,
    ),
    check(
      "execution_leases_identity_chk",
      sql`char_length(btrim(${table.ownerId})) BETWEEN 1 AND 200 AND ${table.tokenDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "execution_leases_lifecycle_chk",
      sql`${table.expiresAt} > ${table.acquiredAt} AND ${table.heartbeatAt} >= ${table.acquiredAt} AND ((${table.status} = 'active' AND ${table.releasedAt} IS NULL) OR (${table.status} <> 'active' AND ${table.releasedAt} IS NOT NULL))`,
    ),
    check("execution_leases_version_chk", sql`${table.version} > 0`),
  ],
);

export const externalEventInbox = pgTable(
  "external_event_inbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    jobId: uuid("job_id").notNull(),
    runId: uuid("run_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    source: text("source").default("autodev").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    sourceEventDigest: text("source_event_digest").notNull(),
    externalRunId: text("external_run_id").notNull(),
    externalTaskId: text("external_task_id").notNull(),
    sourceSequence: integer("source_sequence").notNull(),
    phase: text("phase").notNull(),
    externalStatus: text("external_status").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    processingStatus: text("processing_status")
      .$type<ExternalEventProcessingStatus>().default("pending").notNull(),
    failureReason: text("failure_reason"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    foreignKey({
      name: "external_event_inbox_job_fk",
      columns: [table.jobId],
      foreignColumns: [schedulerJobs.id],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "external_event_inbox_run_fk",
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("external_event_inbox_source_event_uidx").on(
      table.source, table.sourceEventId,
    ),
    uniqueIndex("external_event_inbox_run_sequence_uidx").on(
      table.source, table.externalRunId, table.sourceSequence,
    ),
    index("external_event_inbox_pending_idx").on(
      table.processingStatus, table.receivedAt,
    ),
    check(
      "external_event_inbox_schema_chk",
      sql`${table.schemaVersion} = 'autodev.run-event.v1'`,
    ),
    check(
      "external_event_inbox_digest_chk",
      sql`${table.sourceEventDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "external_event_inbox_sequence_chk",
      sql`${table.sourceSequence} > 0`,
    ),
    check(
      "external_event_inbox_status_chk",
      sql`${table.processingStatus} IN ('pending','applied','duplicate','gap','terminal_ignored','failed')`,
    ),
    check(
      "external_event_inbox_lifecycle_chk",
      sql`(${table.processingStatus} IN ('pending','gap') AND ${table.processedAt} IS NULL) OR (${table.processingStatus} NOT IN ('pending','gap') AND ${table.processedAt} IS NOT NULL)`,
    ),
  ],
);

export const executionControls = pgTable(
  "execution_controls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id"),
    projectId: uuid("project_id"),
    scopeType: text("scope_type").notNull(),
    scopeKey: text("scope_key").notNull(),
    state: text("state").$type<ExecutionControlState>().default("active").notNull(),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    circuitOpenUntil: timestamp("circuit_open_until", { withTimezone: true, mode: "date" }),
    reason: text("reason").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "execution_controls_project_fk",
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("execution_controls_scope_uidx").on(table.scopeType, table.scopeKey),
    check(
      "execution_controls_scope_chk",
      sql`(${table.scopeType} = 'global' AND ${table.scopeKey} = 'global' AND ${table.organizationId} IS NULL AND ${table.projectId} IS NULL) OR (${table.scopeType} = 'project' AND ${table.organizationId} IS NOT NULL AND ${table.projectId} IS NOT NULL AND ${table.scopeKey} = ${table.projectId}::text)`,
    ),
    check(
      "execution_controls_state_chk",
      sql`${table.state} IN ('active','paused','draining','stopped')`,
    ),
    check(
      "execution_controls_failure_chk",
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check(
      "execution_controls_reason_chk",
      sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 4000`,
    ),
    check("execution_controls_version_chk", sql`${table.version} > 0`),
    check(
      "execution_controls_timestamps_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const executionCommandReceipts = pgTable(
  "execution_command_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    requestId: text("request_id").notNull(),
    reason: text("reason").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeKey: text("scope_key").notNull(),
    operation: text("operation").notNull(),
    receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("execution_command_receipts_actor_key_uidx").on(
      table.actorId, table.idempotencyKey,
    ),
    check(
      "execution_command_receipts_identity_chk",
      sql`char_length(btrim(${table.actorId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.idempotencyKey})) BETWEEN 1 AND 200 AND char_length(btrim(${table.requestId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.reason})) BETWEEN 1 AND 4000 AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "execution_command_receipts_scope_chk",
      sql`${table.scopeType} IN ('global','project') AND char_length(btrim(${table.scopeKey})) BETWEEN 1 AND 200`,
    ),
    check(
      "execution_command_receipts_operation_chk",
      sql`${table.operation} IN ('start','pause','drain','resume','retry','stop')`,
    ),
  ],
);

export const taskActionReceipts = pgTable(
  "task_action_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    taskId: text("task_id").notNull(),
    goalId: text("goal_id").notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    requestId: text("request_id").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    status: text("status").$type<TaskActionReceiptStatus>()
      .default("accepted")
      .notNull(),
    taskVersion: integer("task_version").notNull(),
    resultTaskVersion: integer("result_task_version"),
    error: jsonb("error").$type<Record<string, unknown> | null>(),
    version: integer("version").default(1).notNull(),
    completedAt: timestamp("completed_at", {
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
      name: "task_action_receipts_project_fk",
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("task_action_receipts_actor_endpoint_key_uidx").on(
      table.organizationId,
      table.actorId,
      table.taskId,
      table.idempotencyKey,
    ),
    index("task_action_receipts_task_status_idx").on(
      table.organizationId,
      table.projectId,
      table.taskId,
      table.status,
    ),
    check(
      "task_action_receipts_status_chk",
      sql`${table.status} IN ('accepted','running','completed','failed')`,
    ),
    check(
      "task_action_receipts_action_chk",
      sql`${table.action} IN ('review_evidence','answer_questions','resolve_blocker','inspect_schedule','inspect_run')`,
    ),
    check(
      "task_action_receipts_identity_chk",
      sql`char_length(btrim(${table.taskId})) BETWEEN 1 AND 128 AND char_length(btrim(${table.goalId})) BETWEEN 1 AND 128 AND char_length(btrim(${table.actorId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.idempotencyKey})) BETWEEN 8 AND 200 AND ${table.requestHash} ~ '^[0-9a-f]{64}$' AND char_length(btrim(${table.requestId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.reason})) BETWEEN 1 AND 4000`,
    ),
    check(
      "task_action_receipts_version_chk",
      sql`${table.taskVersion} > 0 AND ${table.version} > 0 AND (${table.resultTaskVersion} IS NULL OR ${table.resultTaskVersion} >= ${table.taskVersion})`,
    ),
    check(
      "task_action_receipts_lifecycle_chk",
      sql`((${table.status} IN ('accepted','running') AND ${table.completedAt} IS NULL) OR (${table.status} IN ('completed','failed') AND ${table.completedAt} IS NOT NULL)) AND (${table.status}='failed' OR ${table.error} IS NULL) AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const artifactObjects = pgTable(
  "artifact_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    objectKey: text("object_key").notNull(),
    digest: text("digest").notNull(),
    artifactKind: text("artifact_kind").$type<ArtifactKind>().notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    retentionPolicy: text("retention_policy")
      .$type<ArtifactRetentionPolicy>().notNull(),
    retentionUntil: timestamp("retention_until", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "artifact_objects_project_fk",
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("artifact_objects_scope_id_uidx").on(
      table.organizationId, table.projectId, table.id,
    ),
    uniqueIndex("artifact_objects_scope_digest_uidx").on(
      table.organizationId, table.projectId, table.artifactKind, table.digest,
    ),
    uniqueIndex("artifact_objects_scope_key_uidx").on(
      table.organizationId, table.projectId, table.objectKey,
    ),
    index("artifact_objects_retention_idx").on(
      table.organizationId, table.retentionUntil,
    ),
    check(
      "artifact_objects_digest_chk",
      sql`${table.digest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "artifact_objects_kind_chk",
      sql`${table.artifactKind} IN ('prompt','run_log','test_output','build_result','failure_evidence')`,
    ),
    check(
      "artifact_objects_retention_policy_chk",
      sql`${table.retentionPolicy} IN ('standard_180d','extended_365d','legal_hold')`,
    ),
    check(
      "artifact_objects_metadata_chk",
      sql`char_length(btrim(${table.objectKey})) BETWEEN 1 AND 1000 AND char_length(btrim(${table.mediaType})) BETWEEN 1 AND 200 AND char_length(btrim(${table.createdByActorId})) BETWEEN 1 AND 200 AND ${table.sizeBytes} >= 0 AND ${table.retentionUntil} > ${table.createdAt}`,
    ),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    runId: uuid("run_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    targetCommitSha: text("target_commit_sha").notNull(),
    verdict: text("verdict").$type<ReviewVerdict>().notNull(),
    findings: jsonb("findings").$type<ReviewFinding[]>()
      .default(sql`'[]'::jsonb`).notNull(),
    builderIdentity: text("builder_identity").notNull(),
    reviewerType: text("reviewer_type").$type<"human" | "model">().notNull(),
    reviewerIdentity: text("reviewer_identity").notNull(),
    reviewerVersion: text("reviewer_version").notNull(),
    modelCapability: text("model_capability"),
    reasoningEffort: text("reasoning_effort"),
    inputArtifactDigests: jsonb("input_artifact_digests").$type<string[]>()
      .default(sql`'[]'::jsonb`).notNull(),
    reviewedAt: timestamp("reviewed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "reviews_run_issue_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.issueId,
        table.runId,
      ],
      foreignColumns: [
        runs.organizationId, runs.projectId, runs.goalId, runs.issueId, runs.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("reviews_scope_id_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.issueId,
      table.runId, table.id,
    ),
    uniqueIndex("reviews_run_idempotency_uidx").on(
      table.organizationId, table.runId, table.idempotencyKey,
    ),
    index("reviews_commit_verdict_idx").on(
      table.organizationId, table.projectId, table.issueId,
      table.targetCommitSha, table.verdict,
    ),
    check(
      "reviews_commit_digest_chk",
      sql`${table.targetCommitSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "reviews_verdict_chk",
      sql`${table.verdict} IN ('approved','request_changes','rejected')`,
    ),
    check(
      "reviews_reviewer_chk",
      sql`${table.reviewerType} IN ('human','model') AND char_length(btrim(${table.builderIdentity})) BETWEEN 1 AND 200 AND char_length(btrim(${table.reviewerIdentity})) BETWEEN 1 AND 200 AND lower(btrim(${table.builderIdentity})) <> lower(btrim(${table.reviewerIdentity})) AND char_length(btrim(${table.reviewerVersion})) BETWEEN 1 AND 200 AND ((${table.reviewerType}='human' AND ${table.modelCapability} IS NULL AND ${table.reasoningEffort} IS NULL) OR (${table.reviewerType}='model' AND ${table.modelCapability} IN ('cost_optimized','general_coding','advanced_coding','frontier') AND ${table.reasoningEffort} IN ('low','medium','high','highest')))`,
    ),
    check(
      "reviews_evidence_chk",
      sql`jsonb_typeof(${table.findings})='array' AND jsonb_typeof(${table.inputArtifactDigests})='array' AND jsonb_array_length(${table.inputArtifactDigests}) > 0`,
    ),
    check(
      "reviews_identity_version_chk",
      sql`char_length(btrim(${table.idempotencyKey})) BETWEEN 8 AND 200 AND ${table.version} > 0 AND ${table.reviewedAt} >= ${table.createdAt} AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const credentialReferences = pgTable(
  "credential_references",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    repositoryId: uuid("repository_id").notNull(),
    provider: text("provider").$type<"github_app" | "git_token">().notNull(),
    externalReference: text("external_reference").notNull(),
    allowedScopes: jsonb("allowed_scopes").$type<GitCredentialScope[]>()
      .default(sql`'[]'::jsonb`).notNull(),
    active: boolean("active").default(true).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "credential_references_repository_fk",
      columns: [table.organizationId, table.projectId, table.repositoryId],
      foreignColumns: [
        repositories.organizationId, repositories.projectId, repositories.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("credential_references_scope_id_uidx").on(
      table.organizationId, table.projectId, table.repositoryId, table.id,
    ),
    uniqueIndex("credential_references_external_uidx").on(
      table.organizationId, table.projectId, table.repositoryId,
      table.externalReference,
    ),
    check(
      "credential_references_provider_chk",
      sql`${table.provider} IN ('github_app','git_token')`,
    ),
    check(
      "credential_references_metadata_chk",
      sql`char_length(${table.externalReference}) BETWEEN 18 AND 1000 AND ${table.externalReference} ~ '^secret-manager://[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND jsonb_typeof(${table.allowedScopes})='array' AND ${table.version} > 0 AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const deliveryPolicies = pgTable(
  "delivery_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    repositoryId: uuid("repository_id").notNull(),
    pushMode: text("push_mode").$type<PushMode>()
      .default("push_disabled").notNull(),
    baselineBranch: text("baseline_branch").notNull(),
    branchPrefix: text("branch_prefix").default("autodev/").notNull(),
    protectedBranches: jsonb("protected_branches").$type<string[]>()
      .default(sql`'["main"]'::jsonb`).notNull(),
    credentialReferenceId: uuid("credential_reference_id"),
    revision: integer("revision").notNull(),
    changedByActorId: text("changed_by_actor_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "delivery_policies_repository_fk",
      columns: [table.organizationId, table.projectId, table.repositoryId],
      foreignColumns: [
        repositories.organizationId, repositories.projectId, repositories.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "delivery_policies_credential_fk",
      columns: [
        table.organizationId, table.projectId, table.repositoryId,
        table.credentialReferenceId,
      ],
      foreignColumns: [
        credentialReferences.organizationId, credentialReferences.projectId,
        credentialReferences.repositoryId, credentialReferences.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("delivery_policies_repository_revision_uidx").on(
      table.organizationId, table.projectId, table.repositoryId, table.revision,
    ),
    check(
      "delivery_policies_mode_chk",
      sql`${table.pushMode} IN ('push_disabled','push_branch','push_and_open_pr')`,
    ),
    check(
      "delivery_policies_credential_chk",
      sql`(${table.pushMode}='push_disabled' AND ${table.credentialReferenceId} IS NULL) OR (${table.pushMode}<>'push_disabled' AND ${table.credentialReferenceId} IS NOT NULL)`,
    ),
    check(
      "delivery_policies_metadata_chk",
      sql`char_length(btrim(${table.baselineBranch})) BETWEEN 1 AND 255 AND char_length(btrim(${table.branchPrefix})) BETWEEN 1 AND 255 AND jsonb_typeof(${table.protectedBranches})='array' AND ${table.revision} > 0 AND char_length(btrim(${table.changedByActorId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.reason})) BETWEEN 1 AND 4000 AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const deliveryCandidates = pgTable(
  "delivery_candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    repositoryId: uuid("repository_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    runId: uuid("run_id").notNull(),
    worktreeRef: text("worktree_ref").notNull(),
    baselineBranch: text("baseline_branch").notNull(),
    baselineSha: text("baseline_sha").notNull(),
    branch: text("branch").notNull(),
    commitMessage: text("commit_message").notNull(),
    commitSha: text("commit_sha"),
    reviewId: uuid("review_id"),
    state: text("state").$type<DeliveryCandidateState>()
      .default("verified").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "delivery_candidates_repository_fk",
      columns: [table.organizationId, table.projectId, table.repositoryId],
      foreignColumns: [
        repositories.organizationId, repositories.projectId, repositories.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "delivery_candidates_run_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.issueId,
        table.runId,
      ],
      foreignColumns: [
        runs.organizationId, runs.projectId, runs.goalId, runs.issueId, runs.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "delivery_candidates_review_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.issueId,
        table.runId, table.reviewId,
      ],
      foreignColumns: [
        reviews.organizationId, reviews.projectId, reviews.goalId,
        reviews.issueId, reviews.runId, reviews.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("delivery_candidates_scope_id_uidx").on(
      table.organizationId, table.projectId, table.id,
    ),
    uniqueIndex("delivery_candidates_run_uidx").on(table.runId),
    uniqueIndex("delivery_candidates_branch_uidx").on(
      table.organizationId, table.projectId, table.repositoryId, table.branch,
    ),
    check(
      "delivery_candidates_state_chk",
      sql`${table.state} IN ('verified','committed','reviewed','local_ready','branch_pushed','pr_open','landing','landed','failed')`,
    ),
    check(
      "delivery_candidates_sha_chk",
      sql`${table.baselineSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND (${table.commitSha} IS NULL OR ${table.commitSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')`,
    ),
    check(
      "delivery_candidates_commit_state_chk",
      sql`(${table.state}='verified' AND ${table.commitSha} IS NULL AND ${table.reviewId} IS NULL) OR (${table.state}<>'verified' AND ${table.commitSha} IS NOT NULL)`,
    ),
    check(
      "delivery_candidates_metadata_chk",
      sql`char_length(btrim(${table.worktreeRef})) BETWEEN 1 AND 1000 AND char_length(btrim(${table.baselineBranch})) BETWEEN 1 AND 255 AND char_length(btrim(${table.branch})) BETWEEN 1 AND 255 AND char_length(btrim(${table.commitMessage})) BETWEEN 1 AND 4000 AND ${table.version} > 0 AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const pushReceipts = pgTable(
  "push_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    operationKey: text("operation_key").notNull(),
    externalReceiptId: text("external_receipt_id").notNull(),
    remoteName: text("remote_name").notNull(),
    remoteBranch: text("remote_branch").notNull(),
    commitSha: text("commit_sha").notNull(),
    pushedAt: timestamp("pushed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "push_receipts_candidate_fk",
      columns: [table.organizationId, table.projectId, table.candidateId],
      foreignColumns: [
        deliveryCandidates.organizationId, deliveryCandidates.projectId,
        deliveryCandidates.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("push_receipts_candidate_operation_uidx").on(
      table.candidateId, table.operationKey,
    ),
    uniqueIndex("push_receipts_candidate_uidx").on(table.candidateId),
    check("push_receipts_sha_chk", sql`${table.commitSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
    check("push_receipts_metadata_chk", sql`char_length(btrim(${table.operationKey})) BETWEEN 8 AND 300 AND char_length(btrim(${table.externalReceiptId})) BETWEEN 1 AND 300 AND char_length(btrim(${table.remoteName})) BETWEEN 1 AND 100 AND char_length(btrim(${table.remoteBranch})) BETWEEN 1 AND 255 AND ${table.pushedAt} >= ${table.createdAt}`),
  ],
);

export const pullRequestReceipts = pgTable(
  "pull_request_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    operationKey: text("operation_key").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    headBranch: text("head_branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    status: text("status").default("open").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "pull_request_receipts_candidate_fk",
      columns: [table.organizationId, table.projectId, table.candidateId],
      foreignColumns: [
        deliveryCandidates.organizationId, deliveryCandidates.projectId,
        deliveryCandidates.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("pull_request_receipts_candidate_operation_uidx").on(
      table.candidateId, table.operationKey,
    ),
    uniqueIndex("pull_request_receipts_external_uidx").on(
      table.organizationId, table.externalId,
    ),
    check("pull_request_receipts_status_chk", sql`${table.status} IN ('open','merged','closed')`),
    check("pull_request_receipts_metadata_chk", sql`char_length(btrim(${table.operationKey})) BETWEEN 8 AND 300 AND char_length(btrim(${table.externalId})) BETWEEN 1 AND 300 AND ${table.url} ~ '^https://' AND char_length(btrim(${table.headBranch})) BETWEEN 1 AND 255 AND char_length(btrim(${table.baseBranch})) BETWEEN 1 AND 255 AND ${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const landingReceipts = pgTable(
  "landing_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    operationKey: text("operation_key").notNull(),
    externalId: text("external_id").notNull(),
    landingCommitSha: text("landing_commit_sha").notNull(),
    landedAt: timestamp("landed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "landing_receipts_candidate_fk",
      columns: [table.organizationId, table.projectId, table.candidateId],
      foreignColumns: [
        deliveryCandidates.organizationId, deliveryCandidates.projectId,
        deliveryCandidates.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("landing_receipts_candidate_operation_uidx").on(
      table.candidateId, table.operationKey,
    ),
    uniqueIndex("landing_receipts_candidate_uidx").on(table.candidateId),
    check("landing_receipts_sha_chk", sql`${table.landingCommitSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
    check("landing_receipts_metadata_chk", sql`char_length(btrim(${table.operationKey})) BETWEEN 8 AND 300 AND char_length(btrim(${table.externalId})) BETWEEN 1 AND 300 AND ${table.landedAt} >= ${table.createdAt}`),
  ],
);

export const deliveryOperationReceipts = pgTable(
  "delivery_operation_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    operationKey: text("operation_key").notNull(),
    candidateVersion: integer("candidate_version").notNull(),
    candidateSnapshot: jsonb("candidate_snapshot")
      .$type<import("../app/control-plane/domain/delivery.ts").DeliveryCandidate>()
      .notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "delivery_operation_receipts_candidate_fk",
      columns: [table.organizationId, table.projectId, table.candidateId],
      foreignColumns: [
        deliveryCandidates.organizationId, deliveryCandidates.projectId,
        deliveryCandidates.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("delivery_operation_receipts_candidate_key_uidx").on(
      table.candidateId, table.operationKey,
    ),
    check(
      "delivery_operation_receipts_identity_chk",
      sql`char_length(btrim(${table.operationKey})) BETWEEN 8 AND 300 AND ${table.candidateVersion} > 0`,
    ),
  ],
);

export const acceptanceVerificationPlans = pgTable(
  "acceptance_verification_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    goalVersion: integer("goal_version").notNull(),
    issuePlanId: uuid("issue_plan_id").notNull(),
    issuePlanVersion: integer("issue_plan_version").notNull(),
    revision: integer("revision").notNull(),
    previousPlanId: uuid("previous_plan_id"),
    entries: jsonb("entries").$type<AcceptanceVerificationEntry[]>().notNull(),
    compilation: jsonb("compilation").$type<VerificationPlanCompilation>().notNull(),
    digest: text("digest").notNull(),
    compiledAt: timestamp("compiled_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "acceptance_verification_plans_goal_fk",
      columns: [table.organizationId, table.projectId, table.goalId],
      foreignColumns: [goals.organizationId, goals.projectId, goals.id],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "acceptance_verification_plans_issue_plan_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.issuePlanId,
      ],
      foreignColumns: [
        issuePlanRevisions.organizationId, issuePlanRevisions.projectId,
        issuePlanRevisions.goalId, issuePlanRevisions.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("acceptance_verification_plans_scope_id_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.id,
    ),
    foreignKey({
      name: "acceptance_verification_plans_previous_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.previousPlanId,
      ],
      foreignColumns: [
        table.organizationId, table.projectId, table.goalId, table.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("acceptance_verification_plans_goal_revision_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.revision,
    ),
    check(
      "acceptance_verification_plans_chain_chk",
      sql`${table.revision} > 0 AND ((${table.revision}=1 AND ${table.previousPlanId} IS NULL) OR (${table.revision}>1 AND ${table.previousPlanId} IS NOT NULL))`,
    ),
    check(
      "acceptance_verification_plans_source_chk",
      sql`${table.goalVersion} > 0 AND ${table.issuePlanVersion} > 0 AND ${table.version} > 0`,
    ),
    check(
      "acceptance_verification_plans_payload_chk",
      sql`jsonb_typeof(${table.entries})='array' AND jsonb_array_length(${table.entries}) BETWEEN 1 AND 50 AND jsonb_typeof(${table.compilation})='object' AND ${table.digest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "acceptance_verification_plans_time_chk",
      sql`${table.compiledAt} >= ${table.createdAt}`,
    ),
  ],
);

export const goalVerifications = pgTable(
  "goal_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    verificationPlanId: uuid("verification_plan_id").notNull(),
    issuePlanId: uuid("issue_plan_id").notNull(),
    revision: integer("revision").notNull(),
    previousVerificationId: uuid("previous_verification_id"),
    goalVersion: integer("goal_version").notNull(),
    verdict: text("verdict").$type<GoalVerificationVerdict>().notNull(),
    deterministicResults: jsonb("deterministic_results")
      .$type<DeterministicVerificationResult[]>().notNull(),
    verifierOutput: jsonb("verifier_output").$type<GoalVerifierOutput>().notNull(),
    verifierIdentity: text("verifier_identity").notNull(),
    verifierVersion: text("verifier_version").notNull(),
    sessionId: text("session_id").notNull(),
    verifiedAt: timestamp("verified_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "goal_verifications_plan_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId,
        table.verificationPlanId,
      ],
      foreignColumns: [
        acceptanceVerificationPlans.organizationId,
        acceptanceVerificationPlans.projectId,
        acceptanceVerificationPlans.goalId,
        acceptanceVerificationPlans.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "goal_verifications_issue_plan_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.issuePlanId,
      ],
      foreignColumns: [
        issuePlanRevisions.organizationId, issuePlanRevisions.projectId,
        issuePlanRevisions.goalId, issuePlanRevisions.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("goal_verifications_scope_id_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.id,
    ),
    foreignKey({
      name: "goal_verifications_previous_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId,
        table.previousVerificationId,
      ],
      foreignColumns: [
        table.organizationId, table.projectId, table.goalId, table.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("goal_verifications_goal_revision_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.revision,
    ),
    uniqueIndex("goal_verifications_session_uidx").on(
      table.organizationId, table.sessionId,
    ),
    check(
      "goal_verifications_chain_chk",
      sql`${table.revision} > 0 AND ((${table.revision}=1 AND ${table.previousVerificationId} IS NULL) OR (${table.revision}>1 AND ${table.previousVerificationId} IS NOT NULL))`,
    ),
    check(
      "goal_verifications_verdict_chk",
      sql`${table.verdict} IN ('passed','failed','needs_manual')`,
    ),
    check(
      "goal_verifications_payload_chk",
      sql`${table.goalVersion} > 0 AND ${table.version} > 0 AND jsonb_typeof(${table.deterministicResults})='array' AND jsonb_array_length(${table.deterministicResults}) BETWEEN 1 AND 50 AND jsonb_typeof(${table.verifierOutput})='object'`,
    ),
    check(
      "goal_verifications_identity_chk",
      sql`char_length(btrim(${table.verifierIdentity})) BETWEEN 1 AND 200 AND char_length(btrim(${table.verifierVersion})) BETWEEN 1 AND 200 AND char_length(btrim(${table.sessionId})) BETWEEN 1 AND 200 AND ${table.verifiedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const verificationGapReports = pgTable(
  "verification_gap_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    verificationId: uuid("verification_id").notNull(),
    issuePlanId: uuid("issue_plan_id").notNull(),
    failedCriterionRefs: jsonb("failed_criterion_refs").$type<string[]>().notNull(),
    preservedEvidenceRefs: jsonb("preserved_evidence_refs").$type<string[]>().notNull(),
    gaps: jsonb("gaps").$type<VerificationGap[]>().notNull(),
    createdBy: text("created_by").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "verification_gap_reports_verification_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.verificationId,
      ],
      foreignColumns: [
        goalVerifications.organizationId, goalVerifications.projectId,
        goalVerifications.goalId, goalVerifications.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "verification_gap_reports_issue_plan_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.issuePlanId,
      ],
      foreignColumns: [
        issuePlanRevisions.organizationId, issuePlanRevisions.projectId,
        issuePlanRevisions.goalId, issuePlanRevisions.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("verification_gap_reports_scope_id_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.id,
    ),
    uniqueIndex("verification_gap_reports_verification_uidx").on(
      table.verificationId,
    ),
    check(
      "verification_gap_reports_payload_chk",
      sql`jsonb_typeof(${table.failedCriterionRefs})='array' AND jsonb_array_length(${table.failedCriterionRefs}) <= 50 AND jsonb_typeof(${table.preservedEvidenceRefs})='array' AND jsonb_typeof(${table.gaps})='array' AND jsonb_array_length(${table.gaps}) BETWEEN 1 AND 50`,
    ),
    check(
      "verification_gap_reports_identity_chk",
      sql`char_length(btrim(${table.createdBy})) BETWEEN 1 AND 200 AND ${table.version} > 0`,
    ),
  ],
);

export const gapRemediationReceipts = pgTable(
  "gap_remediation_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    reportId: uuid("report_id").notNull(),
    planId: uuid("plan_id").notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    receipt: jsonb("receipt").$type<GapRemediationReceipt>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "gap_remediation_receipts_report_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.reportId,
      ],
      foreignColumns: [
        verificationGapReports.organizationId,
        verificationGapReports.projectId,
        verificationGapReports.goalId,
        verificationGapReports.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "gap_remediation_receipts_plan_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.planId,
      ],
      foreignColumns: [
        issuePlanRevisions.organizationId, issuePlanRevisions.projectId,
        issuePlanRevisions.goalId, issuePlanRevisions.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("gap_remediation_receipts_idempotency_uidx").on(
      table.organizationId, table.reportId, table.actorId, table.idempotencyKey,
    ),
    check(
      "gap_remediation_receipts_identity_chk",
      sql`char_length(btrim(${table.actorId})) BETWEEN 1 AND 200 AND char_length(${table.idempotencyKey}) BETWEEN 8 AND 200 AND ${table.requestHash} ~ '^[0-9a-f]{64}$' AND jsonb_typeof(${table.receipt})='object'`,
    ),
  ],
);

export const deliveryReports = pgTable(
  "delivery_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    revision: integer("revision").notNull(),
    previousReportId: uuid("previous_report_id"),
    verificationId: uuid("verification_id").notNull(),
    verificationPlanId: uuid("verification_plan_id").notNull(),
    issuePlanId: uuid("issue_plan_id").notNull(),
    goalSnapshot: jsonb("goal_snapshot").$type<import("../app/control-plane/domain/goal-contract.ts").GoalContract>().notNull(),
    acceptance: jsonb("acceptance").$type<DeliveryReportAcceptance[]>().notNull(),
    issueRuns: jsonb("issue_runs").$type<DeliveryIssueRun[]>().notNull(),
    exceptions: jsonb("exceptions").$type<string[]>().notNull(),
    knownRisks: jsonb("known_risks").$type<DeliveryKnownRisk[]>().notNull(),
    regressionRisks: jsonb("regression_risks")
      .$type<GoalVerifierOutput["regressionRisks"]>().notNull(),
    status: text("status").$type<DeliveryReportStatus>().notNull(),
    humanAcceptance: jsonb("human_acceptance").$type<DeliveryHumanAcceptance | null>(),
    digest: text("digest").notNull(),
    generatedBy: text("generated_by").notNull(),
    generatedAt: timestamp("generated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "delivery_reports_verification_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.verificationId,
      ],
      foreignColumns: [
        goalVerifications.organizationId, goalVerifications.projectId,
        goalVerifications.goalId, goalVerifications.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "delivery_reports_verification_plan_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId,
        table.verificationPlanId,
      ],
      foreignColumns: [
        acceptanceVerificationPlans.organizationId,
        acceptanceVerificationPlans.projectId,
        acceptanceVerificationPlans.goalId,
        acceptanceVerificationPlans.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      name: "delivery_reports_issue_plan_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.issuePlanId,
      ],
      foreignColumns: [
        issuePlanRevisions.organizationId, issuePlanRevisions.projectId,
        issuePlanRevisions.goalId, issuePlanRevisions.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    unique("delivery_reports_scope_id_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.id,
    ),
    foreignKey({
      name: "delivery_reports_previous_fk",
      columns: [
        table.organizationId, table.projectId, table.goalId, table.previousReportId,
      ],
      foreignColumns: [
        table.organizationId, table.projectId, table.goalId, table.id,
      ],
    }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("delivery_reports_goal_revision_uidx").on(
      table.organizationId, table.projectId, table.goalId, table.revision,
    ),
    check(
      "delivery_reports_chain_chk",
      sql`${table.revision} > 0 AND ((${table.revision}=1 AND ${table.previousReportId} IS NULL) OR (${table.revision}>1 AND ${table.previousReportId} IS NOT NULL))`,
    ),
    check(
      "delivery_reports_status_chk",
      sql`(${table.status}='awaiting_human_acceptance' AND ${table.humanAcceptance} IS NULL) OR (${table.status}='accepted' AND jsonb_typeof(${table.humanAcceptance})='object')`,
    ),
    check(
      "delivery_reports_payload_chk",
      sql`jsonb_typeof(${table.goalSnapshot})='object' AND jsonb_typeof(${table.acceptance})='array' AND jsonb_array_length(${table.acceptance}) BETWEEN 1 AND 50 AND jsonb_typeof(${table.issueRuns})='array' AND jsonb_array_length(${table.issueRuns}) > 0 AND jsonb_typeof(${table.exceptions})='array' AND jsonb_typeof(${table.knownRisks})='array' AND jsonb_typeof(${table.regressionRisks})='array'`,
    ),
    check(
      "delivery_reports_identity_chk",
      sql`${table.digest} ~ '^[0-9a-f]{64}$' AND char_length(btrim(${table.generatedBy})) BETWEEN 1 AND 200 AND ${table.version} > 0 AND ${table.generatedAt} >= ${table.createdAt}`,
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
    policyRevision: text("policy_revision").default("legacy-policy").notNull(),
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
      sql`char_length(btrim(${table.actorId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.action})) BETWEEN 1 AND 200 AND char_length(btrim(${table.entityType})) BETWEEN 1 AND 100 AND ${table.entityVersion} > 0 AND char_length(btrim(${table.reason})) BETWEEN 1 AND 4000 AND char_length(btrim(${table.requestId})) BETWEEN 1 AND 200 AND char_length(btrim(${table.policyRevision})) BETWEEN 1 AND 100`,
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
export type ArtifactObject = typeof artifactObjects.$inferSelect;
export type NewArtifactObject = typeof artifactObjects.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type CredentialReferenceRecord = typeof credentialReferences.$inferSelect;
export type NewCredentialReferenceRecord = typeof credentialReferences.$inferInsert;
export type DeliveryPolicyRecord = typeof deliveryPolicies.$inferSelect;
export type NewDeliveryPolicyRecord = typeof deliveryPolicies.$inferInsert;
export type DeliveryCandidateRecord = typeof deliveryCandidates.$inferSelect;
export type NewDeliveryCandidateRecord = typeof deliveryCandidates.$inferInsert;
export type PushReceiptRecord = typeof pushReceipts.$inferSelect;
export type NewPushReceiptRecord = typeof pushReceipts.$inferInsert;
export type PullRequestReceiptRecord = typeof pullRequestReceipts.$inferSelect;
export type NewPullRequestReceiptRecord = typeof pullRequestReceipts.$inferInsert;
export type LandingReceiptRecord = typeof landingReceipts.$inferSelect;
export type NewLandingReceiptRecord = typeof landingReceipts.$inferInsert;
export type AcceptanceVerificationPlanRecord = typeof acceptanceVerificationPlans.$inferSelect;
export type GoalVerificationRecord = typeof goalVerifications.$inferSelect;
export type VerificationGapReportRecord = typeof verificationGapReports.$inferSelect;
export type GapRemediationReceiptRecord = typeof gapRemediationReceipts.$inferSelect;
export type DeliveryReportRecord = typeof deliveryReports.$inferSelect;
export type DeliveryOperationReceiptRecord = typeof deliveryOperationReceipts.$inferSelect;
export type NewDeliveryOperationReceiptRecord = typeof deliveryOperationReceipts.$inferInsert;
export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type SchedulerJobRecord = typeof schedulerJobs.$inferSelect;
export type NewSchedulerJobRecord = typeof schedulerJobs.$inferInsert;
export type ExecutionNode = typeof executionNodes.$inferSelect;
export type NewExecutionNode = typeof executionNodes.$inferInsert;
export type ExecutionLease = typeof executionLeases.$inferSelect;
export type NewExecutionLease = typeof executionLeases.$inferInsert;
export type ExternalEventInboxRecord = typeof externalEventInbox.$inferSelect;
export type NewExternalEventInboxRecord = typeof externalEventInbox.$inferInsert;
export type ExecutionControl = typeof executionControls.$inferSelect;
export type NewExecutionControl = typeof executionControls.$inferInsert;
export type ExecutionCommandReceipt = typeof executionCommandReceipts.$inferSelect;
export type NewExecutionCommandReceipt = typeof executionCommandReceipts.$inferInsert;
export type TaskActionReceiptRecord = typeof taskActionReceipts.$inferSelect;
export type NewTaskActionReceiptRecord = typeof taskActionReceipts.$inferInsert;
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

export const workbenchProjectionCheckpoints = pgTable(
  "workbench_projection_checkpoints",
  {
    scopeId: text("scope_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    lastEventAt: timestamp("last_event_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastEventId: uuid("last_event_id"),
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
    foreignKey({
      name: "workbench_projection_checkpoints_project_fk",
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "workbench_projection_checkpoints_revision_chk",
      sql`${table.revision} > 0`,
    ),
    check(
      "workbench_projection_checkpoints_digest_chk",
      sql`${table.snapshotDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workbench_projection_checkpoints_cursor_chk",
      sql`(${table.lastEventAt} IS NULL AND ${table.lastEventId} IS NULL) OR (${table.lastEventAt} IS NOT NULL AND ${table.lastEventId} IS NOT NULL)`,
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
