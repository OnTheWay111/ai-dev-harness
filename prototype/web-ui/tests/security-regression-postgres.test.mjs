import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";

import { PolicyEvaluator, AuthorizationDeniedError } from
  "../app/auth/rbac-policy.ts";
import { PostgresRoleBindingRepository } from
  "../app/auth/postgres-role-binding-repository.ts";
import { GoalApplicationService } from
  "../app/control-plane/application/goal-application-service.ts";
import { PostgresGoalRepository } from
  "../app/control-plane/adapters/postgres-goal-repository.ts";
import { handleWorkbenchRequest } from
  "../app/api/v1/workbench/route.ts";
import { workbenchSnapshot } from
  "../app/workbench/server/demo-workbench-snapshot.ts";
import {
  NodePostgresWorkbenchProjectionWriter,
  NodePostgresWorkbenchReadStore,
} from "../app/workbench/server/node-postgres-workbench-store.ts";
import { PostgresWorkbenchReadRepository } from
  "../app/workbench/server/postgres-workbench-repository.ts";

const databaseUrl = process.env.POSTGRES_INTEGRATION_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const { Pool } = pg;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;

after(async () => {
  await pool?.end();
});

async function insertScope(label, status = "draft", version = 1) {
  const organizationId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const goalId = crypto.randomUUID();
  const suffix = `${process.pid}-${label}-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO organizations (id, slug, name)
     VALUES ($1, $2, 'Security regression organization')`,
    [organizationId, `security-org-${suffix}`],
  );
  await pool.query(
    `INSERT INTO projects (id, organization_id, slug, name)
     VALUES ($1, $2, $3, 'Security regression project')`,
    [projectId, organizationId, `security-project-${suffix}`],
  );
  await pool.query(
    `INSERT INTO goals
       (id, organization_id, project_id, title, problem_statement,
        desired_outcome, status, version)
     VALUES ($1, $2, $3, 'Security regression goal',
             'Protect tenant boundaries', 'No unauthorized transition', $4, $5)`,
    [goalId, organizationId, projectId, status, version],
  );
  return { organizationId, projectId, goalId };
}

async function bind(scope, actorId, role) {
  await pool.query(
    `INSERT INTO role_bindings
       (id, organization_id, project_id, actor_id, role,
        assigned_by_actor_id, reason, request_id)
     VALUES ($1, $2, $3, $4, $5, 'security-fixture',
             'Security regression fixture', $6)`,
    [
      crypto.randomUUID(),
      scope.organizationId,
      scope.projectId,
      actorId,
      role,
      `security-${crypto.randomUUID()}`,
    ],
  );
}

async function insertGoal(scope, status = "draft", version = 1) {
  const goalId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO goals
       (id, organization_id, project_id, title, problem_statement,
        desired_outcome, status, version)
     VALUES ($1, $2, $3, 'Second security regression goal',
             'Keep actor keys isolated', 'No cross-user receipt replay', $4, $5)`,
    [goalId, scope.organizationId, scope.projectId, status, version],
  );
  return { ...scope, goalId };
}

function securedGoalService() {
  const policy = new PolicyEvaluator(new PostgresRoleBindingRepository(pool));
  return new GoalApplicationService({
    repository: new PostgresGoalRepository(pool),
    authorizer: {
      async authorize(command) {
        await policy.assertAllowed({
          actorId: command.actorId,
          organizationId: command.organizationId,
          projectId: command.projectId,
          permission: command.nextState === "approved"
            ? "goal.approve"
            : "goal.write",
        });
      },
    },
  });
}

function transition(scope, actorId, overrides = {}) {
  return {
    ...scope,
    actorId,
    requestId: `security-${crypto.randomUUID()}`,
    idempotencyKey: `security-${crypto.randomUUID()}`,
    expectedVersion: 1,
    nextState: "clarifying",
    reason: "Security regression transition",
    guards: {},
    ...overrides,
  };
}

integrationTest(
  "anonymous access and cross-organization ID guessing fail before data is returned",
  async () => {
    const other = await insertScope("other");
    const actorScope = await insertScope("actor");
    await bind(actorScope, "security-viewer", "viewer");
    const repository = new PostgresWorkbenchReadRepository(
      new NodePostgresWorkbenchReadStore(pool),
      `security-anonymous-${process.pid}`,
    );
    const anonymous = await handleWorkbenchRequest(
      new Request("http://localhost/api/v1/workbench"),
      () => repository,
      async () => null,
    );
    assert.equal(anonymous.status, 401);

    await assert.rejects(
      () => securedGoalService().transition(
        transition(other, "security-viewer"),
      ),
      AuthorizationDeniedError,
    );
    const records = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM audit_events WHERE goal_id = $1) AS audits,
         (SELECT count(*)::integer FROM idempotency_records
           WHERE organization_id = $2 AND actor_id = 'security-viewer') AS idempotency`,
      [other.goalId, other.organizationId],
    );
    assert.deepEqual(records.rows[0], { audits: 0, idempotency: 0 });
  },
);

integrationTest(
  "project roles cannot escalate into approval",
  async () => {
    const scope = await insertScope("escalation", "planning", 3);
    await bind(scope, "security-project-admin", "project_admin");
    await assert.rejects(
      () => securedGoalService().transition(
        transition(scope, "security-project-admin", {
          expectedVersion: 3,
          nextState: "approved",
          guards: { specApproved: true },
        }),
      ),
      AuthorizationDeniedError,
    );
    const persisted = await pool.query(
      "SELECT status, version FROM goals WHERE id = $1",
      [scope.goalId],
    );
    assert.deepEqual(persisted.rows[0], { status: "planning", version: 3 });
  },
);

integrationTest(
  "duplicate approval replays once while the same key remains isolated by actor",
  async () => {
    const first = await insertScope("approval", "planning", 3);
    const second = await insertGoal(first, "planning", 3);
    await bind(first, "security-approver-1", "approver");
    await bind(second, "security-approver-2", "approver");
    const service = securedGoalService();
    const sharedKey = "security-shared-approval-key";
    const firstCommand = transition(first, "security-approver-1", {
      requestId: "security-approval-first",
      idempotencyKey: sharedKey,
      expectedVersion: 3,
      nextState: "approved",
      reason: "Approve reviewed specification",
      guards: { specApproved: true },
    });
    const receipt = await service.transition(firstCommand);
    assert.deepEqual(await service.transition(firstCommand), receipt);
    await service.transition(transition(second, "security-approver-2", {
      requestId: "security-approval-second",
      idempotencyKey: sharedKey,
      expectedVersion: 3,
      nextState: "approved",
      reason: "Approve a different reviewed specification",
      guards: { specApproved: true },
    }));

    const records = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM audit_events
           WHERE goal_id = $1 AND action = 'goal.state_changed') AS first_audits,
         (SELECT count(*)::integer FROM outbox_events
           WHERE aggregate_id = $1 AND event_type = 'goal.state_changed') AS first_events,
         (SELECT count(*)::integer FROM idempotency_records
           WHERE key = $2 AND actor_id IN ($3, $4)) AS actor_keys`,
      [first.goalId, sharedKey, "security-approver-1", "security-approver-2"],
    );
    assert.deepEqual(records.rows[0], {
      first_audits: 1,
      first_events: 1,
      actor_keys: 2,
    });
  },
);

integrationTest(
  "audit rows reject missing identity and all later tampering",
  async () => {
    const scope = await insertScope("audit");
    const auditId = crypto.randomUUID();
    await assert.rejects(
      () => pool.query(
        `INSERT INTO audit_events
           (id, organization_id, project_id, goal_id, actor_id, action,
            entity_type, entity_id, entity_version, reason, request_id,
            retention_until)
         VALUES ($1, $2, $3, $4, '', 'goal.state_changed', 'goal', $4, 1,
                 '', '', CURRENT_TIMESTAMP + interval '1 day')`,
        [auditId, scope.organizationId, scope.projectId, scope.goalId],
      ),
      /check constraint/i,
    );
    await pool.query(
      `INSERT INTO audit_events
         (id, organization_id, project_id, goal_id, actor_id, action,
          entity_type, entity_id, entity_version, reason, request_id,
          retention_until)
       VALUES ($1, $2, $3, $4, 'security-auditor', 'goal.state_changed',
               'goal', $4, 1, 'Recorded reason', 'security-audit-request',
               CURRENT_TIMESTAMP + interval '1 day')`,
      [auditId, scope.organizationId, scope.projectId, scope.goalId],
    );
    await assert.rejects(
      () => pool.query(
        "UPDATE audit_events SET reason = 'tampered' WHERE id = $1",
        [auditId],
      ),
      /append-only/i,
    );
    await assert.rejects(
      () => pool.query("DELETE FROM audit_events WHERE id = $1", [auditId]),
      /append-only/i,
    );
  },
);

integrationTest(
  "cross-project pages cannot leak content, total, summary, or ETag state",
  async () => {
    const a = await insertScope("visibility-a");
    const b = await insertScope("visibility-b");
    const scopeId = `security-visibility-${process.pid}`;
    const writer = new NodePostgresWorkbenchProjectionWriter(pool);
    const snapshot = (revision, tasks) => ({
      ...structuredClone(workbenchSnapshot),
      revision,
      tasks,
    });
    await writer.replaceProjection(
      { scopeId, organizationId: a.organizationId, projectId: a.projectId },
      snapshot(701, workbenchSnapshot.tasks.slice(0, 2)),
    );
    await writer.replaceProjection(
      { scopeId, organizationId: b.organizationId, projectId: b.projectId },
      snapshot(799, [{
        ...structuredClone(workbenchSnapshot.tasks[2]),
        id: "B-SECRET-TASK",
        title: "B secret task",
      }]),
    );
    const repository = new PostgresWorkbenchReadRepository(
      new NodePostgresWorkbenchReadStore(pool),
      scopeId,
    );
    const visibilityA = {
      actorId: "security-a",
      organizationIds: [],
      projectIds: [a.projectId],
    };
    const visibilityB = {
      actorId: "security-b",
      organizationIds: [],
      projectIds: [b.projectId],
    };
    const responseA = await handleWorkbenchRequest(
      new Request("http://localhost/api/v1/workbench?limit=1"),
      () => repository,
      async () => visibilityA,
    );
    const bodyA = await responseA.json();
    assert.equal(bodyA.page.total, 2);
    assert.equal(bodyA.data.summary.taskCounts.all, 2);
    assert.doesNotMatch(JSON.stringify(bodyA), /B-SECRET-TASK|B secret task/);

    const responseB = await handleWorkbenchRequest(
      new Request("http://localhost/api/v1/workbench?limit=1", {
        headers: { "if-none-match": responseA.headers.get("etag") ?? "" },
      }),
      () => repository,
      async () => visibilityB,
    );
    assert.equal(responseB.status, 200);
    assert.notEqual(responseA.headers.get("etag"), responseB.headers.get("etag"));
    const bodyB = await responseB.json();
    assert.equal(bodyB.page.total, 1);
    assert.equal(bodyB.data.summary.taskCounts.all, 1);
  },
);
