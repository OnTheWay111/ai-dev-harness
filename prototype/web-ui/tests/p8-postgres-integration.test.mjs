import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import {
  PostgresWorkbenchProjectionPublisher,
  PostgresWorkbenchProjectionSource,
} from "../app/workbench/projection/postgres-workbench-projector.ts";
import { WorkbenchProjectionRunner } from
  "../app/workbench/projection/workbench-projection-runner.ts";
import { PostgresTaskActionRepository } from
  "../app/workbench/server/postgres-task-action-repository.ts";
import { TaskActionService } from
  "../app/workbench/server/task-action-service.ts";

const databaseUrl = process.env.POSTGRES_INTEGRATION_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const { Pool } = pg;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 6 })
  : undefined;
const ids = {
  organization: crypto.randomUUID(),
  project: crypto.randomUUID(),
  goal: crypto.randomUUID(),
  spec: crypto.randomUUID(),
  issue: crypto.randomUUID(),
  run: crypto.randomUUID(),
  job: crypto.randomUUID(),
  event: crypto.randomUUID(),
};
const scope = {
  scopeId: `p8_${ids.project.slice(0, 8)}`,
  organizationId: ids.organization,
  projectId: ids.project,
};

before(async () => {
  if (!pool) return;
  const now = new Date("2026-08-05T02:00:00.000Z");
  await pool.query(
    "INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'P8 organization')",
    [ids.organization, `p8-org-${ids.organization.slice(0, 8)}`],
  );
  await pool.query(
    "INSERT INTO projects (id,organization_id,slug,name) VALUES ($1,$2,$3,'P8 project')",
    [ids.project, ids.organization, `p8-project-${ids.project.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO goals
      (id,organization_id,project_id,title,problem_statement,desired_outcome,
       status,created_at,updated_at)
     VALUES ($1,$2,$3,'P8 goal','Project live workbench facts','Realtime control plane',
             'executing',$4,$4)`,
    [ids.goal, ids.organization, ids.project, now],
  );
  await pool.query(
    `INSERT INTO spec_revisions
      (id,organization_id,project_id,goal_id,revision,status,source_goal_version,
       artifact_ref,artifact_digest,generated_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,1,'approved',1,'artifact://p8',$5,$6,$6,$6)`,
    [ids.spec, ids.organization, ids.project, ids.goal, "a".repeat(64), now],
  );
  await pool.query(
    `INSERT INTO issues
      (id,organization_id,project_id,goal_id,spec_revision_id,issue_key,
       revision,status,title,body_ref,body_digest,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'P8-LIVE',1,'blocked','P8 live issue',
             'artifact://p8-issue',$6,$7,$7)`,
    [
      ids.issue, ids.organization, ids.project, ids.goal, ids.spec,
      "b".repeat(64), now,
    ],
  );
  await pool.query(
    `INSERT INTO runs
      (id,organization_id,project_id,goal_id,issue_id,attempt,status,request_id,
       started_at,finished_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,1,'failed','p8-integration',$6,$7,$6,$7)`,
    [
      ids.run, ids.organization, ids.project, ids.goal, ids.issue,
      now, new Date(now.getTime() + 60_000),
    ],
  );
  await pool.query(
    `INSERT INTO scheduler_jobs
      (id,organization_id,project_id,goal_id,issue_id,run_id,external_task_id,
       state,phase,priority,budget,deadline_at,next_attempt_at,failure_code,
       failure_reason,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'P8-LIVE','blocked','queued',20,
             '{"conflictKeys":["database:migrations"],"tokensUsed":10,"tokenLimit":100}'::jsonb,
             $7,$8,'resource_conflict','database:migrations is held',$8,$8)`,
    [
      ids.job, ids.organization, ids.project, ids.goal, ids.issue, ids.run,
      new Date(now.getTime() + 3_600_000), new Date(now.getTime() + 60_000),
    ],
  );
  await pool.query(
    `INSERT INTO outbox_events
      (id,organization_id,aggregate_type,aggregate_id,aggregate_version,
       event_type,deduplication_key,payload,created_at,updated_at)
     VALUES ($1,$2,'run',$3,1,'run.failed',$4,'{}'::jsonb,$5,$5)`,
    [ids.event, ids.organization, ids.run, `p8-run-${ids.run}`, new Date(now.getTime() + 60_000)],
  );
});

after(async () => {
  await pool?.end();
});

integrationTest("P8 PostgreSQL projector publishes atomically and ignores semantic duplicate triggers", async () => {
  const source = new PostgresWorkbenchProjectionSource({ pool, scopeId: scope.scopeId });
  const publisher = new PostgresWorkbenchProjectionPublisher(pool);
  const runner = new WorkbenchProjectionRunner({
    source,
    publisher,
    clock: () => new Date("2026-08-05T02:05:00.000Z"),
  });
  await runner.projectScope(scope);
  const first = await publisher.readState(scope);
  assert.equal(first.revision, 1);
  assert.equal(first.snapshot.tasks[0].id, `${ids.goal}:P8-LIVE`);
  assert.equal(first.snapshot.tasks[0].attention.severity, "blocking");
  assert.equal(first.snapshot.summary.metrics.length, 6);

  await pool.query(
    `INSERT INTO outbox_events
      (id,organization_id,aggregate_type,aggregate_id,aggregate_version,
       event_type,deduplication_key,payload,created_at,updated_at)
     VALUES ($1,$2,'run',$3,2,'run.progress_observed',$4,'{}'::jsonb,$5,$5)`,
    [
      crypto.randomUUID(), ids.organization, ids.run,
      `p8-run-duplicate-${ids.run}`,
      new Date("2026-08-05T02:02:00.000Z"),
    ],
  );
  await runner.projectScope(scope);
  const duplicate = await publisher.readState(scope);
  assert.equal(duplicate.revision, 1);
  assert.notEqual(duplicate.cursor.eventId, first.cursor.eventId);
});

integrationTest("P8 PostgreSQL task action is authorized before one durable Receipt/Audit/Outbox transaction", async () => {
  const repository = new PostgresTaskActionRepository({ pool, scopeId: scope.scopeId });
  const service = new TaskActionService({
    repository,
    authorizer: { async authorize() {} },
    clock: () => new Date("2026-08-05T02:06:00.000Z"),
    idFactory: () => crypto.randomUUID(),
  });
  const visibility = {
    actorId: "p8-operator",
    organizationIds: [],
    projectIds: [ids.project],
  };
  const command = {
    taskId: `${ids.goal}:P8-LIVE`,
    actorId: visibility.actorId,
    visibility,
    requestId: "p8-action-request",
    idempotencyKey: `p8-action-${ids.issue}`,
    request: {
      action: "resolve_blocker",
      expectedVersion: 3,
      reason: "Release the conflict after operator verification",
      input: { resolution: "release_conflict" },
    },
  };
  const started = performance.now();
  const [receipt, concurrentReplay] = await Promise.all([
    service.submit(command),
    service.submit(command),
  ]);
  assert.ok(performance.now() - started < 500, "durable PostgreSQL acceptance must stay below 500ms");
  assert.equal(receipt.status, "accepted");
  assert.deepEqual(concurrentReplay, receipt);
  assert.deepEqual(await service.submit(command), receipt);
  assert.equal((await service.transitionReceipt(receipt.receiptId, "running")).status, "running");
  assert.equal((await service.transitionReceipt(receipt.receiptId, "completed", { taskVersion: 4 })).status, "completed");

  const rows = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM task_action_receipts WHERE id=$1) AS receipts,
       (SELECT count(*)::integer FROM audit_events WHERE entity_id=$1) AS audits,
       (SELECT count(*)::integer FROM audit_events
         WHERE entity_id=$1 AND details_ref=$2 AND details_digest IS NOT NULL) AS detailed_audits,
       (SELECT count(*)::integer FROM outbox_events WHERE aggregate_id=$1) AS events`,
    [
      receipt.receiptId.replace("rcpt_", ""),
      `db://task_action_receipts/${receipt.receiptId.replace("rcpt_", "")}`,
    ],
  );
  assert.deepEqual(rows.rows[0], {
    receipts: 1,
    audits: 1,
    detailed_audits: 1,
    events: 3,
  });
});
