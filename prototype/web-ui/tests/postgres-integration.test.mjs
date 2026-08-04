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

const databaseUrl = process.env.POSTGRES_INTEGRATION_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const { Pool } = pg;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;
const scopePrefix = `p1_04_${process.pid}`;

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
  assert.equal(migrations.length, 3);
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
      "clarifications",
      "decisions",
      "goals",
      "issue_dependencies",
      "issues",
      "organizations",
      "projects",
      "repositories",
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
