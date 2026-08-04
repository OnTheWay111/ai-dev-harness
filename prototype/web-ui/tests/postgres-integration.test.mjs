import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import { workbenchSnapshot } from
  "../app/workbench/server/demo-workbench-snapshot.ts";
import {
  NodePostgresWorkbenchProjectionWriter,
  NodePostgresWorkbenchReadStore,
} from "../app/workbench/server/node-postgres-workbench-store.ts";
import { PostgresWorkbenchReadRepository } from
  "../app/workbench/server/postgres-workbench-repository.ts";
import { loadPostgresMigrations } from "../scripts/postgres-migration.ts";
import {
  goalStateMachine,
  issueStateMachine,
  runStateMachine,
  specRevisionStateMachine,
  transitionState,
} from "../app/control-plane/domain/state-machines.ts";
import {
  PostgresVersionedStateStore,
  VersionConflictError,
} from "../app/control-plane/adapters/postgres-versioned-state-store.ts";
import {
  PostgresGoalRepository,
} from "../app/control-plane/adapters/postgres-goal-repository.ts";
import {
  GoalApplicationService,
} from "../app/control-plane/application/goal-application-service.ts";
import {
  IdempotencyConflictError,
} from "../app/control-plane/domain/errors.ts";
import { assertGoalRepositoryContract } from "./goal-repository-contract.mjs";

const databaseUrl = process.env.POSTGRES_INTEGRATION_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const { Pool } = pg;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;
const scopePrefix = `p1_04_${process.pid}`;

async function insertReliableGoal(label) {
  const organizationId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const goalId = crypto.randomUUID();
  const suffix = `${process.pid}-${label}-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO organizations (id, slug, name)
     VALUES ($1, $2, 'Reliable command organization')`,
    [organizationId, `reliable-org-${suffix}`],
  );
  await pool.query(
    `INSERT INTO projects (id, organization_id, slug, name)
     VALUES ($1, $2, $3, 'Reliable command project')`,
    [projectId, organizationId, `reliable-project-${suffix}`],
  );
  await pool.query(
    `INSERT INTO goals
       (id, organization_id, project_id, title,
        problem_statement, desired_outcome)
     VALUES ($1, $2, $3, 'Reliable command goal',
             'A write may be retried or race.',
             'Commit exactly once or fail without partial state.')`,
    [goalId, organizationId, projectId],
  );
  return { organizationId, projectId, goalId };
}

function reliableCommand(scope, overrides = {}) {
  return {
    ...scope,
    actorId: "integration-actor",
    requestId: "integration-request",
    idempotencyKey: "integration-idempotency",
    expectedVersion: 1,
    nextState: "clarifying",
    reason: "Verify reliable command handling",
    guards: {},
    ...overrides,
  };
}

function reliableService(repository, ids) {
  const availableIds = [...ids];
  return new GoalApplicationService({
    repository,
    authorizer: { async authorize() {} },
    clock: () => new Date(),
    idGenerator: () => {
      const id = availableIds.shift();
      assert.ok(id, "the command generated only the expected records");
      return id;
    },
  });
}

before(async () => {
  if (!pool) return;
  await pool.query(
    "DELETE FROM workbench_tasks WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
  await pool.query(
    "DELETE FROM workbench_snapshots WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
});

after(async () => {
  if (!pool) return;
  await pool.query(
    "DELETE FROM workbench_tasks WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
  await pool.query(
    "DELETE FROM workbench_snapshots WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
  await pool.end();
});

integrationTest("migrates an empty temporary PostgreSQL database", async () => {
  const migrations = loadPostgresMigrations(
    new URL("../drizzle-postgres/", import.meta.url),
  );
  assert.equal(migrations.length, 5);
  const ledger = await pool.query(
    "SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at",
  );
  assert.deepEqual(
    ledger.rows,
    migrations.map((migration) => ({
      hash: migration.hash,
      created_at: String(migration.createdAt),
    })),
  );
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    [
      "acceptance_criteria",
      "audit_events",
      "clarifications",
      "decisions",
      "evidence",
      "goals",
      "idempotency_records",
      "issue_dependencies",
      "issues",
      "organizations",
      "outbox_events",
      "projects",
      "repositories",
      "runs",
      "spec_revisions",
      "workbench_snapshots",
      "workbench_tasks",
    ],
  );
});

integrationTest(
  "enforces Organization, version, and acceptance constraints",
  async () => {
    const organizationId = crypto.randomUUID();
    const otherOrganizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();
    const repositoryId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const criterionId = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO organizations (id, slug, name)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          organizationId,
          `p2-org-${process.pid}`,
          "P2 Organization",
          otherOrganizationId,
          `p2-other-${process.pid}`,
          "Other Organization",
        ],
      );
      await pool.query(
        `INSERT INTO projects (id, organization_id, slug, name)
         VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)`,
        [
          projectId,
          organizationId,
          `p2-project-${process.pid}`,
          "P2 Project",
          otherProjectId,
          `p2-other-project-${process.pid}`,
          "Other P2 Project",
        ],
      );
      await pool.query(
        `INSERT INTO repositories
           (id, organization_id, project_id, provider,
            provider_repository_id, owner, name, default_branch)
         VALUES ($1, $2, $3, 'github', $4, $5, $6, 'main')`,
        [
          repositoryId,
          organizationId,
          projectId,
          `provider-${process.pid}`,
          "example",
          "repository",
        ],
      );
      await pool.query(
        `INSERT INTO goals
           (id, organization_id, project_id, title,
            problem_statement, desired_outcome)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          goalId,
          organizationId,
          projectId,
          "P2 Goal",
          "The control plane has no authoritative goal record.",
          "Persist a Goal inside its Organization boundary.",
        ],
      );
      await pool.query(
        `INSERT INTO acceptance_criteria
           (id, organization_id, project_id, goal_id, position, statement)
         VALUES ($1, $2, $3, $4, 1, $5)`,
        [
          criterionId,
          organizationId,
          projectId,
          goalId,
          "The goal can be traced to its project and organization.",
        ],
      );

      const hierarchy = await pool.query(
        `SELECT o.slug AS organization_slug, p.slug AS project_slug,
                r.name AS repository_name, g.title AS goal_title,
                ac.statement
         FROM organizations o
         JOIN projects p ON p.organization_id = o.id
         JOIN repositories r
           ON r.organization_id = p.organization_id AND r.project_id = p.id
         JOIN goals g
           ON g.organization_id = p.organization_id AND g.project_id = p.id
         JOIN acceptance_criteria ac
           ON ac.organization_id = g.organization_id
          AND ac.project_id = g.project_id AND ac.goal_id = g.id
         WHERE o.id = $1`,
        [organizationId],
      );
      assert.equal(hierarchy.rowCount, 1);

      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO repositories
               (organization_id, project_id, provider,
                provider_repository_id, owner, name, default_branch)
             VALUES ($1, $2, 'github', $3, 'wrong', 'organization', 'main')`,
            [
              otherOrganizationId,
              projectId,
              `cross-organization-${process.pid}`,
            ],
          ),
        /foreign key/i,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO acceptance_criteria
               (organization_id, project_id, goal_id, position, statement)
             VALUES ($1, $2, $3, 2, 'Cross-Project criterion')`,
            [organizationId, otherProjectId, goalId],
          ),
        /foreign key/i,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO acceptance_criteria
               (organization_id, project_id, goal_id, position, statement)
             VALUES ($1, $2, $3, 2, 'Cross-Organization criterion')`,
            [otherOrganizationId, projectId, goalId],
          ),
        /foreign key/i,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO goals
               (organization_id, project_id, title,
                problem_statement, desired_outcome, version)
             VALUES ($1, $2, 'Invalid', 'Invalid version', 'Rejected', 0)`,
            [organizationId, projectId],
          ),
        /check constraint/i,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO acceptance_criteria
               (organization_id, project_id, goal_id, position, statement)
             VALUES ($1, $2, $3, 1, 'Duplicate position')`,
            [organizationId, projectId, goalId],
          ),
        /unique constraint/i,
      );
    } finally {
      await pool.query(
        "DELETE FROM acceptance_criteria WHERE organization_id IN ($1, $2)",
        [organizationId, otherOrganizationId],
      );
      await pool.query(
        "DELETE FROM goals WHERE organization_id IN ($1, $2)",
        [organizationId, otherOrganizationId],
      );
      await pool.query(
        "DELETE FROM repositories WHERE organization_id IN ($1, $2)",
        [organizationId, otherOrganizationId],
      );
      await pool.query(
        "DELETE FROM projects WHERE organization_id IN ($1, $2)",
        [organizationId, otherOrganizationId],
      );
      await pool.query(
        "DELETE FROM organizations WHERE id IN ($1, $2)",
        [organizationId, otherOrganizationId],
      );
    }
  },
);

integrationTest(
  "enforces immutable planning history and Goal-scoped dependencies",
  async () => {
    const client = await pool.connect();
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const otherGoalId = crypto.randomUUID();
    const specRevisionId = crypto.randomUUID();
    const otherSpecRevisionId = crypto.randomUUID();
    const firstIssueId = crypto.randomUUID();
    const secondIssueId = crypto.randomUUID();
    const otherIssueId = crypto.randomUUID();
    const clarificationId = crypto.randomUUID();
    const clarificationThreadId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    const digest = "a".repeat(64);
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organizations (id, slug, name)
         VALUES ($1, $2, 'Planning Organization')`,
        [organizationId, `planning-${process.pid}`],
      );
      await client.query(
        `INSERT INTO projects (id, organization_id, slug, name)
         VALUES ($1, $2, $3, 'Planning Project')`,
        [projectId, organizationId, `planning-${process.pid}`],
      );
      await client.query(
        `INSERT INTO goals
           (id, organization_id, project_id, title,
            problem_statement, desired_outcome)
         VALUES ($1, $3, $4, 'Planning Goal', 'Plan safely', 'A valid plan'),
                ($2, $3, $4, 'Other Goal', 'Stay isolated', 'No leakage')`,
        [goalId, otherGoalId, organizationId, projectId],
      );
      await client.query(
        `INSERT INTO spec_revisions
           (id, organization_id, project_id, goal_id, revision,
            source_goal_version, artifact_ref, artifact_digest)
         VALUES ($1, $3, $4, $5, 1, 1, 'artifact://spec/one', $7),
                ($2, $3, $4, $6, 1, 1, 'artifact://spec/two', $7)`,
        [
          specRevisionId,
          otherSpecRevisionId,
          organizationId,
          projectId,
          goalId,
          otherGoalId,
          digest,
        ],
      );
      await client.query(
        `INSERT INTO issues
           (id, organization_id, project_id, goal_id, spec_revision_id,
            issue_key, revision, title, body_ref, body_digest)
         VALUES ($1, $4, $5, $6, $7, 'PLAN-1', 1,
                 'First issue', 'artifact://issue/one', $9),
                ($2, $4, $5, $6, $7, 'PLAN-2', 1,
                 'Second issue', 'artifact://issue/two', $9),
                ($3, $4, $5, $8, $10, 'OTHER-1', 1,
                 'Other issue', 'artifact://issue/other', $9)`,
        [
          firstIssueId,
          secondIssueId,
          otherIssueId,
          organizationId,
          projectId,
          goalId,
          specRevisionId,
          otherGoalId,
          digest,
          otherSpecRevisionId,
        ],
      );
      await client.query(
        `INSERT INTO issue_dependencies
           (organization_id, project_id, goal_id, issue_id, depends_on_issue_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [organizationId, projectId, goalId, secondIssueId, firstIssueId],
      );
      await client.query("SAVEPOINT invalid_dependency");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO issue_dependencies
               (organization_id, project_id, goal_id, issue_id,
                depends_on_issue_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [organizationId, projectId, goalId, firstIssueId, otherIssueId],
          ),
        /foreign key/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_dependency");
      await client.query("SAVEPOINT self_dependency");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO issue_dependencies
               (organization_id, project_id, goal_id, issue_id,
                depends_on_issue_id)
             VALUES ($1, $2, $3, $4, $4)`,
            [organizationId, projectId, goalId, firstIssueId],
          ),
        /check constraint/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT self_dependency");

      await client.query(
        `INSERT INTO clarifications
           (id, organization_id, project_id, goal_id, thread_id, revision,
            status, question, source_goal_version)
         VALUES ($1, $2, $3, $4, $5, 1, 'open',
                 'Which boundary applies?', 1)`,
        [
          clarificationId,
          organizationId,
          projectId,
          goalId,
          clarificationThreadId,
        ],
      );
      await client.query("SAVEPOINT immutable_clarification");
      await assert.rejects(
        () =>
          client.query(
            "UPDATE clarifications SET question = 'overwritten' WHERE id = $1",
            [clarificationId],
          ),
        /append-only/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT immutable_clarification");
      await client.query(
        `INSERT INTO clarifications
           (organization_id, project_id, goal_id, thread_id, revision,
            previous_clarification_id, status, question, answer,
            source_goal_version)
         VALUES ($1, $2, $3, $4, 2, $5, 'answered',
                 'Which boundary applies?', 'The Organization boundary.', 1)`,
        [organizationId, projectId, goalId, clarificationThreadId, clarificationId],
      );

      await client.query(
        `INSERT INTO decisions
           (id, organization_id, project_id, goal_id, decision_key, revision,
            status, subject_type, subject_id, subject_version, outcome, reason)
         VALUES ($1, $2, $3, $4, $5, 1, 'approved', 'issue_plan', $6, 1,
                 'Use the Goal-scoped dependency graph',
                 'Cross-Goal dependencies are not allowed')`,
        [
          decisionId,
          organizationId,
          projectId,
          goalId,
          crypto.randomUUID(),
          specRevisionId,
        ],
      );
      await client.query("SAVEPOINT immutable_decision");
      await assert.rejects(
        () => client.query("DELETE FROM decisions WHERE id = $1", [decisionId]),
        /append-only/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT immutable_decision");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  },
);

integrationTest(
  "enforces evidence, audit, Outbox, and idempotency invariants",
  async () => {
    const client = await pool.connect();
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const specRevisionId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const evidenceId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const digest = "b".repeat(64);
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organizations (id, slug, name)
         VALUES ($1, $2, 'Reliability Organization')`,
        [organizationId, `reliability-${process.pid}`],
      );
      await client.query(
        `INSERT INTO projects (id, organization_id, slug, name)
         VALUES ($1, $2, $3, 'Reliability Project')`,
        [projectId, organizationId, `reliability-${process.pid}`],
      );
      await client.query(
        `INSERT INTO goals
           (id, organization_id, project_id, title,
            problem_statement, desired_outcome)
         VALUES ($1, $2, $3, 'Reliable writes',
                 'Events need durable evidence', 'Trace every write')`,
        [goalId, organizationId, projectId],
      );
      await client.query(
        `INSERT INTO spec_revisions
           (id, organization_id, project_id, goal_id, revision,
            source_goal_version, artifact_ref, artifact_digest)
         VALUES ($1, $2, $3, $4, 1, 1, 'artifact://spec/reliable', $5)`,
        [specRevisionId, organizationId, projectId, goalId, digest],
      );
      await client.query(
        `INSERT INTO issues
           (id, organization_id, project_id, goal_id, spec_revision_id,
            issue_key, revision, title, body_ref, body_digest)
         VALUES ($1, $2, $3, $4, $5, 'RELIABLE-1', 1,
                 'Reliable issue', 'artifact://issue/reliable', $6)`,
        [issueId, organizationId, projectId, goalId, specRevisionId, digest],
      );
      await client.query(
        `INSERT INTO runs
           (id, organization_id, project_id, goal_id, issue_id,
            attempt, request_id)
         VALUES ($1, $2, $3, $4, $5, 1, 'req-reliability')`,
        [runId, organizationId, projectId, goalId, issueId],
      );
      await client.query("SAVEPOINT duplicate_attempt");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO runs
               (organization_id, project_id, goal_id, issue_id,
                attempt, request_id)
             VALUES ($1, $2, $3, $4, 1, 'req-duplicate')`,
            [organizationId, projectId, goalId, issueId],
          ),
        /unique constraint/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT duplicate_attempt");

      await client.query(
        `INSERT INTO evidence
           (id, organization_id, project_id, goal_id, issue_id, run_id,
            kind, artifact_ref, digest, media_type, size_bytes,
            retention_until)
         VALUES ($1, $2, $3, $4, $5, $6, 'test',
                 'artifact://evidence/test', $7, 'application/json', 128,
                 '2030-01-01T00:00:00Z')`,
        [evidenceId, organizationId, projectId, goalId, issueId, runId, digest],
      );
      await client.query("SAVEPOINT immutable_evidence");
      await assert.rejects(
        () =>
          client.query("UPDATE evidence SET size_bytes = 129 WHERE id = $1", [
            evidenceId,
          ]),
        /append-only/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT immutable_evidence");

      await client.query(
        `INSERT INTO audit_events
           (id, organization_id, project_id, goal_id, actor_id, action,
            entity_type, entity_id, entity_version, reason, request_id,
            retention_until)
         VALUES ($1, $2, $3, $4, 'actor-1', 'run.queued', 'run', $5, 1,
                 'Start approved work', 'req-reliability',
                 '2030-01-01T00:00:00Z')`,
        [auditEventId, organizationId, projectId, goalId, runId],
      );
      await client.query("SAVEPOINT immutable_audit");
      await assert.rejects(
        () =>
          client.query("DELETE FROM audit_events WHERE id = $1", [auditEventId]),
        /append-only/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT immutable_audit");

      await client.query(
        `INSERT INTO outbox_events
           (organization_id, aggregate_type, aggregate_id,
            aggregate_version, event_type, deduplication_key, payload)
         VALUES ($1, 'run', $2, 1, 'run.queued', 'run-queued-once',
                 '{"status":"queued"}'::jsonb)`,
        [organizationId, runId],
      );
      await client.query("SAVEPOINT duplicate_outbox");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO outbox_events
               (organization_id, aggregate_type, aggregate_id,
                aggregate_version, event_type, deduplication_key, payload)
             VALUES ($1, 'run', $2, 1, 'run.queued', 'run-queued-once', '{}')`,
            [organizationId, runId],
          ),
        /unique constraint/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT duplicate_outbox");

      await client.query(
        `INSERT INTO idempotency_records
           (organization_id, actor_id, endpoint, key, request_hash, expires_at)
         VALUES ($1, 'actor-1', '/goals/actions', 'idem-1', $2,
                 '2030-01-01T00:00:00Z')`,
        [organizationId, digest],
      );
      await client.query("SAVEPOINT duplicate_idempotency");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO idempotency_records
               (organization_id, actor_id, endpoint, key,
                request_hash, expires_at)
             VALUES ($1, 'actor-1', '/goals/actions', 'idem-1', $2,
                     '2030-01-01T00:00:00Z')`,
            [organizationId, digest],
          ),
        /unique constraint/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT duplicate_idempotency");
      await client.query(
        `INSERT INTO idempotency_records
           (organization_id, actor_id, endpoint, key, request_hash, expires_at)
         VALUES ($1, 'actor-2', '/goals/actions', 'idem-1', $2,
                 '2030-01-01T00:00:00Z')`,
        [organizationId, digest],
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  },
);

integrationTest(
  "persists guarded state transitions with optimistic versions",
  async () => {
    const client = await pool.connect();
    const store = new PostgresVersionedStateStore(client);
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const specRevisionId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const digest = "c".repeat(64);
    const occurredAt = new Date("2026-08-04T09:30:00.000Z");
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organizations (id, slug, name)
         VALUES ($1, $2, 'State Organization')`,
        [organizationId, `state-${process.pid}`],
      );
      await client.query(
        `INSERT INTO projects (id, organization_id, slug, name)
         VALUES ($1, $2, $3, 'State Project')`,
        [projectId, organizationId, `state-${process.pid}`],
      );
      await client.query(
        `INSERT INTO goals
           (id, organization_id, project_id, title,
            problem_statement, desired_outcome)
         VALUES ($1, $2, $3, 'State Goal', 'Prevent races', 'One transition')`,
        [goalId, organizationId, projectId],
      );
      await client.query(
        `INSERT INTO spec_revisions
           (id, organization_id, project_id, goal_id, revision,
            source_goal_version, artifact_ref, artifact_digest)
         VALUES ($1, $2, $3, $4, 1, 1, 'artifact://spec/state', $5)`,
        [specRevisionId, organizationId, projectId, goalId, digest],
      );
      await client.query(
        `INSERT INTO issues
           (id, organization_id, project_id, goal_id, spec_revision_id,
            issue_key, revision, title, body_ref, body_digest)
         VALUES ($1, $2, $3, $4, $5, 'STATE-1', 1,
                 'State issue', 'artifact://issue/state', $6)`,
        [issueId, organizationId, projectId, goalId, specRevisionId, digest],
      );
      await client.query(
        `INSERT INTO runs
           (id, organization_id, project_id, goal_id, issue_id,
            attempt, request_id)
         VALUES ($1, $2, $3, $4, $5, 1, 'req-state')`,
        [runId, organizationId, projectId, goalId, issueId],
      );

      const goalTransition = transitionState({
        machine: goalStateMachine,
        currentState: "draft",
        currentVersion: 1,
        expectedVersion: 1,
        nextState: "clarifying",
        guards: {},
      });
      assert.deepEqual(
        await store.persist({
          entity: "goal",
          id: goalId,
          organizationId,
          projectId,
          expectedVersion: goalTransition.previousVersion,
          nextState: goalTransition.state,
          occurredAt,
        }),
        { state: "clarifying", version: 2 },
      );
      await assert.rejects(
        () =>
          store.persist({
            entity: "goal",
            id: goalId,
            organizationId,
            projectId,
            expectedVersion: 1,
            nextState: "planning",
            occurredAt,
          }),
        (error) => error instanceof VersionConflictError,
      );

      for (const transition of [
        {
          machine: specRevisionStateMachine,
          currentState: "draft",
          nextState: "in_review",
          guards: { artifactDigestVerified: true },
          entity: "specRevision",
          id: specRevisionId,
        },
        {
          machine: issueStateMachine,
          currentState: "draft",
          nextState: "approved",
          guards: { specApproved: true },
          entity: "issue",
          id: issueId,
        },
        {
          machine: runStateMachine,
          currentState: "queued",
          nextState: "running",
          guards: {},
          entity: "run",
          id: runId,
        },
      ]) {
        const result = transitionState({
          machine: transition.machine,
          currentState: transition.currentState,
          currentVersion: 1,
          expectedVersion: 1,
          nextState: transition.nextState,
          guards: transition.guards,
        });
        assert.equal(
          (await store.persist({
            entity: transition.entity,
            id: transition.id,
            organizationId,
            projectId,
            goalId,
            expectedVersion: result.previousVersion,
            nextState: result.state,
            occurredAt,
          })).version,
          2,
        );
      }
      const persisted = await client.query(
        `SELECT g.status AS goal_status, g.version AS goal_version,
                sr.status AS spec_status, i.status AS issue_status,
                r.status AS run_status, r.started_at, r.finished_at
           FROM goals g
           JOIN spec_revisions sr ON sr.goal_id = g.id
           JOIN issues i ON i.spec_revision_id = sr.id
           JOIN runs r ON r.issue_id = i.id
          WHERE g.id = $1`,
        [goalId],
      );
      assert.deepEqual(
        {
          goalStatus: persisted.rows[0].goal_status,
          goalVersion: persisted.rows[0].goal_version,
          specStatus: persisted.rows[0].spec_status,
          issueStatus: persisted.rows[0].issue_status,
          runStatus: persisted.rows[0].run_status,
          hasStarted: persisted.rows[0].started_at instanceof Date,
          finishedAt: persisted.rows[0].finished_at,
        },
        {
          goalStatus: "clarifying",
          goalVersion: 2,
          specStatus: "in_review",
          issueStatus: "approved",
          runStatus: "running",
          hasStarted: true,
          finishedAt: null,
        },
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  },
);

integrationTest(
  "matches the in-memory GoalRepository contract with PostgreSQL",
  async () => {
    const goal = {
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      title: "Repository contract",
      status: "draft",
      version: 1,
    };
    const repository = new PostgresGoalRepository(pool);
    await pool.query(
      `INSERT INTO organizations (id, slug, name)
       VALUES ($1, $2, 'Repository Contract Organization')`,
      [goal.organizationId, `repository-contract-${process.pid}`],
    );
    await pool.query(
      `INSERT INTO projects (id, organization_id, slug, name)
       VALUES ($1, $2, $3, 'Repository Contract Project')`,
      [goal.projectId, goal.organizationId, `repository-contract-${process.pid}`],
    );
    await pool.query(
      `INSERT INTO goals
         (id, organization_id, project_id, title,
          problem_statement, desired_outcome)
       VALUES ($1, $2, $3, $4, 'Hide persistence', 'One stable interface')`,
      [goal.id, goal.organizationId, goal.projectId, goal.title],
    );
    await assertGoalRepositoryContract({
      repository,
      goal,
      eventCount: async (eventId) =>
        Number((await pool.query(
          "SELECT count(*)::int AS count FROM outbox_events WHERE id = $1",
          [eventId],
        )).rows[0].count),
    });
  },
);

integrationTest(
  "commits Goal, Audit, Outbox, and idempotency once and replays the receipt",
  async () => {
    const scope = await insertReliableGoal("replay");
    const repository = new PostgresGoalRepository(pool);
    const service = reliableService(repository, [
      crypto.randomUUID(),
      crypto.randomUUID(),
    ]);
    const first = await service.transition(reliableCommand(scope));
    const replay = await service.transition(reliableCommand(scope, {
      requestId: "integration-retry",
    }));
    assert.deepEqual(replay, first);
    await assert.rejects(
      () => service.transition(reliableCommand(scope, {
        reason: "A different command must not share the same key",
      })),
      (error) => error instanceof IdempotencyConflictError,
    );

    const persisted = await pool.query(
      `SELECT g.status, g.version,
              (SELECT count(*)::int FROM audit_events ae
                WHERE ae.goal_id = g.id) AS audit_count,
              (SELECT count(*)::int FROM outbox_events oe
                WHERE oe.aggregate_id = g.id) AS outbox_count,
              (SELECT count(*)::int FROM idempotency_records ir
                WHERE ir.organization_id = g.organization_id
                  AND ir.key = 'integration-idempotency') AS idempotency_count
         FROM goals g WHERE g.id = $1`,
      [scope.goalId],
    );
    assert.deepEqual(persisted.rows[0], {
      status: "clarifying",
      version: 2,
      audit_count: 1,
      outbox_count: 1,
      idempotency_count: 1,
    });
    const outbox = await pool.query(
      `SELECT status, attempts, published_at, payload->'receipt' AS receipt
         FROM outbox_events WHERE id = $1`,
      [first.eventId],
    );
    assert.deepEqual(outbox.rows[0], {
      status: "pending",
      attempts: 0,
      published_at: null,
      receipt: first,
    });
  },
);

integrationTest(
  "serializes duplicate commands and rejects concurrent stale versions",
  async () => {
    const duplicateScope = await insertReliableGoal("duplicate-race");
    const duplicateRepository = new PostgresGoalRepository(pool);
    const duplicateCommand = reliableCommand(duplicateScope, {
      idempotencyKey: "same-concurrent-key",
    });
    const duplicateReceipts = await Promise.all([
      reliableService(duplicateRepository, [
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]).transition(duplicateCommand),
      reliableService(duplicateRepository, [
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]).transition({ ...duplicateCommand, requestId: "concurrent-retry" }),
    ]);
    assert.deepEqual(duplicateReceipts[1], duplicateReceipts[0]);
    const duplicateCounts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM audit_events WHERE goal_id = $1) AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS outbox,
         (SELECT count(*)::int FROM idempotency_records
           WHERE organization_id = $2 AND key = 'same-concurrent-key') AS idempotency`,
      [duplicateScope.goalId, duplicateScope.organizationId],
    );
    assert.deepEqual(duplicateCounts.rows[0], {
      audits: 1,
      outbox: 1,
      idempotency: 1,
    });

    const conflictScope = await insertReliableGoal("version-race");
    const conflictRepository = new PostgresGoalRepository(pool);
    const results = await Promise.allSettled([
      reliableService(conflictRepository, [
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]).transition(reliableCommand(conflictScope, {
        idempotencyKey: "version-race-a",
      })),
      reliableService(conflictRepository, [
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]).transition(reliableCommand(conflictScope, {
        idempotencyKey: "version-race-b",
        requestId: "version-race-b",
      })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.reason instanceof VersionConflictError);
    const conflictCounts = await pool.query(
      `SELECT g.status, g.version,
              (SELECT count(*)::int FROM audit_events WHERE goal_id = g.id) AS audits,
              (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = g.id) AS outbox,
              (SELECT count(*)::int FROM idempotency_records
                WHERE organization_id = g.organization_id
                  AND key LIKE 'version-race-%') AS idempotency
         FROM goals g WHERE g.id = $1`,
      [conflictScope.goalId],
    );
    assert.deepEqual(conflictCounts.rows[0], {
      status: "clarifying",
      version: 2,
      audits: 1,
      outbox: 1,
      idempotency: 1,
    });
  },
);

integrationTest(
  "rolls back the entire reliable command when Audit insertion fails",
  async () => {
    const scope = await insertReliableGoal("rollback");
    const eventId = crypto.randomUUID();
    const duplicateAuditId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO audit_events
         (id, organization_id, project_id, goal_id, actor_id, action,
          entity_type, entity_id, entity_version, reason, request_id,
          retention_until)
       VALUES ($1, $2, $3, $4, 'fixture', 'fixture.created', 'goal', $4, 1,
               'Create rollback fixture', 'fixture-request', now() + interval '180 days')`,
      [duplicateAuditId, scope.organizationId, scope.projectId, scope.goalId],
    );
    const service = reliableService(new PostgresGoalRepository(pool), [
      eventId,
      duplicateAuditId,
    ]);
    await assert.rejects(
      () => service.transition(reliableCommand(scope, {
        idempotencyKey: "rollback-key",
      })),
      /duplicate key/i,
    );
    const persisted = await pool.query(
      `SELECT g.status, g.version,
              (SELECT count(*)::int FROM audit_events WHERE goal_id = g.id) AS audits,
              (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = g.id) AS outbox,
              (SELECT count(*)::int FROM idempotency_records
                WHERE organization_id = g.organization_id
                  AND key = 'rollback-key') AS idempotency
         FROM goals g WHERE g.id = $1`,
      [scope.goalId],
    );
    assert.deepEqual(persisted.rows[0], {
      status: "draft",
      version: 1,
      audits: 1,
      outbox: 0,
      idempotency: 0,
    });
  },
);

integrationTest(
  "replaces and reads a real projection with consistent revision and filters",
  async () => {
    const scopeId = `${scopePrefix}_projection`;
    const writer = new NodePostgresWorkbenchProjectionWriter(pool);
    const repository = new PostgresWorkbenchReadRepository(
      new NodePostgresWorkbenchReadStore(pool),
      scopeId,
    );
    const snapshot = {
      ...structuredClone(workbenchSnapshot),
      revision: 204,
      generatedAt: "2026-08-04T06:00:00.000Z",
    };
    await writer.replaceProjection(scopeId, snapshot);

    const firstPage = await repository.getWorkbench({ limit: 2 });
    assert.equal(firstPage.data.revision, 204);
    assert.deepEqual(
      firstPage.data.tasks.map((task) => task.id),
      ["DEV-07", "ORD-02"],
    );
    assert.deepEqual(firstPage.page, { nextCursor: "wb1_2", total: 7 });

    const attentionFirst = await repository.getWorkbench({
      filter: "attention",
      limit: 2,
    });
    const attentionSecond = await repository.getWorkbench({
      filter: "attention",
      limit: 2,
      cursor: attentionFirst.page.nextCursor,
    });
    assert.equal(attentionFirst.page.total, 4);
    assert.equal(attentionFirst.data.tasks.length, 2);
    assert.equal(attentionSecond.data.tasks.length, 2);
    assert.ok(
      [...attentionFirst.data.tasks, ...attentionSecond.data.tasks].every(
        (task) => task.attention.required,
      ),
    );

    assert.equal(
      (await repository.getWorkbench({ goalId: "GOAL-2407" })).page.total,
      4,
    );
    assert.equal(
      (await repository.getWorkbench({ filter: "blocked" })).page.total,
      2,
    );
    assert.equal(
      (await repository.getWorkbench({ filter: "running" })).page.total,
      1,
    );
  },
);

integrationTest("fails on empty projection and invalid cursors", async () => {
  const store = new NodePostgresWorkbenchReadStore(pool);
  const empty = new PostgresWorkbenchReadRepository(
    store,
    `${scopePrefix}_empty`,
  );
  await assert.rejects(
    () => empty.getWorkbench(),
    /snapshot is unavailable/i,
  );

  const populated = new PostgresWorkbenchReadRepository(
    store,
    `${scopePrefix}_projection`,
  );
  await assert.rejects(
    () => populated.getWorkbench({ cursor: "invalid" }),
    /cursor/i,
  );
  await assert.rejects(
    () => populated.getWorkbench({ cursor: "wb1_999" }),
    /cursor/i,
  );
});

integrationTest("rolls back a partially failed projection replacement", async () => {
  const scopeId = `${scopePrefix}_rollback`;
  const writer = new NodePostgresWorkbenchProjectionWriter(pool);
  const repository = new PostgresWorkbenchReadRepository(
    new NodePostgresWorkbenchReadStore(pool),
    scopeId,
  );
  await writer.replaceProjection(scopeId, {
    ...structuredClone(workbenchSnapshot),
    revision: 301,
  });

  const invalid = structuredClone(workbenchSnapshot);
  invalid.revision = 302;
  invalid.tasks[0].progress.updatedAt = "not-a-timestamp";
  await assert.rejects(() => writer.replaceProjection(scopeId, invalid));

  const preserved = await repository.getWorkbench();
  assert.equal(preserved.data.revision, 301);
  assert.equal(preserved.data.tasks.length, 7);
  assert.equal(preserved.data.tasks[0].id, "DEV-07");
});

integrationTest("surfaces a real PostgreSQL connection failure", async () => {
  const unavailablePool = new Pool({
    connectionString: "postgresql://postgres@127.0.0.1:1/postgres",
    connectionTimeoutMillis: 200,
  });
  const repository = new PostgresWorkbenchReadRepository(
    new NodePostgresWorkbenchReadStore(unavailablePool),
    "unavailable",
  );
  try {
    await assert.rejects(() => repository.getWorkbench());
  } finally {
    await unavailablePool.end();
  }
});
