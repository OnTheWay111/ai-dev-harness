import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import { PostgresExecutionControlRepository } from
  "../app/control-plane/adapters/postgres-execution-control-repository.ts";
import { PostgresExecutionEventRepository } from
  "../app/control-plane/adapters/postgres-execution-event-repository.ts";
import { PostgresSchedulerRepository } from
  "../app/control-plane/adapters/postgres-scheduler-repository.ts";
import { PostgresSchedulerAdmissionRepository } from
  "../app/control-plane/adapters/postgres-scheduler-admission-repository.ts";
import { PostgresSchedulerAdmissionSource } from
  "../app/control-plane/adapters/postgres-scheduler-admission-source.ts";
import { ExecutionControlService } from
  "../app/control-plane/application/execution-control-service.ts";
import { ExternalEventService } from
  "../app/control-plane/application/external-event-service.ts";
import { SchedulerAdmissionService } from
  "../app/control-plane/application/scheduler-admission-service.ts";

const databaseUrl = process.env.POSTGRES_INTEGRATION_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const { Pool } = pg;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 8 })
  : undefined;

const ids = {
  organization: crypto.randomUUID(),
  project: crypto.randomUUID(),
  goal: crypto.randomUUID(),
  spec: crypto.randomUUID(),
  issuePlan: crypto.randomUUID(),
  queueProjection: crypto.randomUUID(),
  issue: crypto.randomUUID(),
  admissionIssue: crypto.randomUUID(),
  run: crypto.randomUUID(),
  job: crypto.randomUUID(),
  nodeA: crypto.randomUUID(),
  nodeB: crypto.randomUUID(),
};
const externalRunId = `p7-${ids.run}-a1`;

before(async () => {
  if (!pool) return;
  await pool.query(
    `INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'P7 organization')`,
    [ids.organization, `p7-org-${ids.organization.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO projects (id,organization_id,slug,name)
     VALUES ($1,$2,$3,'P7 project')`,
    [ids.project, ids.organization, `p7-project-${ids.project.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO goals
      (id,organization_id,project_id,title,problem_statement,desired_outcome)
     VALUES ($1,$2,$3,'P7 goal','Execute one durable task','Retain one owner')`,
    [ids.goal, ids.organization, ids.project],
  );
  await pool.query(
    `INSERT INTO spec_revisions
      (id,organization_id,project_id,goal_id,revision,status,source_goal_version,
       artifact_ref,artifact_digest)
     VALUES ($1,$2,$3,$4,1,'approved',1,'artifact://p7',$5)`,
    [ids.spec, ids.organization, ids.project, ids.goal, "a".repeat(64)],
  );
  await pool.query(
    `INSERT INTO issues
      (id,organization_id,project_id,goal_id,spec_revision_id,issue_key,
       revision,status,title,body_ref,body_digest)
     VALUES ($1,$2,$3,$4,$5,'P7-TEST',1,'ready','P7 test issue',
             'artifact://p7-issue',$6)`,
    [
      ids.issue, ids.organization, ids.project, ids.goal, ids.spec,
      "b".repeat(64),
    ],
  );
  const projectedAt = new Date();
  await pool.query(
    `INSERT INTO issue_plan_revisions
      (id,organization_id,project_id,goal_id,spec_revision_id,revision,status,
       source_spec_version,source_spec_digest,plan_data,digest,planner_run_id,
       planner_configuration,compiler_policy_revision,conflict_policy_revision,
       model_router_policy_revision,generated_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,1,'approved',1,$6,'{}'::jsonb,$7,'p7-planner',
             '{}'::jsonb,'compiler.v1','conflict.v1','model-router.v1',$8,$8,$8)`,
    [
      ids.issuePlan, ids.organization, ids.project, ids.goal, ids.spec,
      "a".repeat(64), "d".repeat(64), projectedAt,
    ],
  );
  await pool.query(
    `INSERT INTO model_recommendations
      (organization_id,project_id,goal_id,issue_plan_id,issue_key,
       capability_tier,reasoning_effort,factors,reasons,policy_revision)
     VALUES ($1,$2,$3,$4,'P7-ADMIT','general_coding','medium',
             '{"risk":"low","codeScope":"narrow","domainComplexity":"standard","verificationDifficulty":"standard"}'::jsonb,
             '["P7 integration route"]'::jsonb,'model-router.v1')`,
    [ids.organization, ids.project, ids.goal, ids.issuePlan],
  );
  const projectionReceipt = {
    importId: `p7-import-${ids.queueProjection}`,
    atomic: true,
    organizationId: ids.organization,
    projectId: ids.project,
    goalId: ids.goal,
    issuePlanId: ids.issuePlan,
    planDigest: "d".repeat(64),
    requestId: `p7-projection-${ids.queueProjection}`,
    idempotencyKey: `p7-projection-${ids.queueProjection}`,
    projectedAt: projectedAt.toISOString(),
    tasks: [{ issueKey: "P7-ADMIT", externalTaskId: "H-7001" }],
  };
  await pool.query(
    `INSERT INTO queue_projections
      (id,organization_id,project_id,goal_id,issue_plan_id,plan_digest,
       idempotency_key,request_id,external_import_id,status,receipt,
       created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',$10::jsonb,$11,$11)`,
    [
      ids.queueProjection, ids.organization, ids.project, ids.goal,
      ids.issuePlan, projectionReceipt.planDigest, projectionReceipt.idempotencyKey,
      projectionReceipt.requestId, projectionReceipt.importId,
      JSON.stringify(projectionReceipt), projectedAt,
    ],
  );
  await pool.query(
    `INSERT INTO issues
      (id,organization_id,project_id,goal_id,spec_revision_id,issue_key,
       revision,status,title,body_ref,body_digest)
     VALUES ($1,$2,$3,$4,$5,'P7-ADMIT',1,'ready','P7 admission issue',
             'artifact://p7-admission-issue',$6)`,
    [
      ids.admissionIssue, ids.organization, ids.project, ids.goal, ids.spec,
      "c".repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO runs
      (id,organization_id,project_id,goal_id,issue_id,attempt,status,request_id)
     VALUES ($1,$2,$3,$4,$5,1,'queued','p7-integration')`,
    [ids.run, ids.organization, ids.project, ids.goal, ids.issue],
  );
  await pool.query(
    `INSERT INTO scheduler_jobs
      (id,organization_id,project_id,goal_id,issue_id,run_id,external_task_id,
       deadline_at,next_attempt_at,max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,'H-001',$7,$8,2)`,
    [
      ids.job, ids.organization, ids.project, ids.goal, ids.issue, ids.run,
      new Date(Date.now() + 60 * 60 * 1000), new Date(Date.now() - 1000),
    ],
  );
});

after(async () => {
  if (!pool) return;
  // The integration runner owns and drops this temporary database. Audit and
  // planning history are deliberately append-only, so row-by-row teardown
  // would violate the same production invariant this suite verifies.
  await pool.end();
});

integrationTest("P7 PostgreSQL claim and lease concurrency yields one owner", async () => {
  const repository = new PostgresSchedulerRepository(pool);
  const now = new Date();
  for (const [id, name] of [[ids.nodeA, "p7-node-a"], [ids.nodeB, "p7-node-b"]]) {
    await repository.registerNode({
      id,
      name: `${name}-${ids.run.slice(0, 8)}`,
      provider: "local",
      capabilities: [id === ids.nodeA ? "cost_optimized" : "general_coding"],
      maxConcurrentRuns: 1,
      now,
      offlineAfter: new Date(now.getTime() + 60_000),
    });
  }
  const claims = await Promise.all([
    repository.claimNext(now, "scheduler-a"),
    repository.claimNext(now, "scheduler-b"),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claimed = claims.find(Boolean);
  assert.equal((await repository.selectNode(claimed, now))?.id, ids.nodeB);

  const leases = await Promise.all([
    repository.acquireLease({
      runId: ids.run, nodeId: ids.nodeA, ownerId: "scheduler-a", now,
      expiresAt: new Date(now.getTime() + 60_000),
    }),
    repository.acquireLease({
      runId: ids.run, nodeId: ids.nodeB, ownerId: "scheduler-b", now,
      expiresAt: new Date(now.getTime() + 60_000),
    }),
  ]);
  assert.equal(leases.filter(Boolean).length, 1);
  const stored = await pool.query(
    "SELECT count(*)::integer AS count FROM execution_leases WHERE run_id=$1 AND status='active'",
    [ids.run],
  );
  assert.equal(stored.rows[0].count, 1);
});

integrationTest("P7 PostgreSQL Inbox closes gaps and transitions Run with Outbox", async () => {
  await pool.query(
    `UPDATE scheduler_jobs
        SET state='running',external_run_id=$1,reconciliation_required=false
      WHERE id=$2`,
    [externalRunId, ids.job],
  );
  const service = new ExternalEventService({
    repository: new PostgresExecutionEventRepository(pool),
  });
  const base = {
    schemaVersion: "autodev.run-event.v1",
    externalRunId,
    externalTaskId: "H-001",
  };
  assert.equal((await service.ingest({
    ...base, sourceEventId: "p7-event-2", sequence: 2,
    occurredAt: new Date(Date.now() + 2000).toISOString(),
    phase: "done", status: "succeeded", message: "done",
  })).disposition, "gap");
  assert.equal((await service.ingest({
    ...base, sourceEventId: "p7-event-1", sequence: 1,
    occurredAt: new Date(Date.now() + 1000).toISOString(),
    phase: "builder", status: "running", message: "running",
  })).disposition, "applied");
  const run = await pool.query("SELECT status FROM runs WHERE id=$1", [ids.run]);
  assert.equal(run.rows[0].status, "succeeded");
  const inbox = await pool.query(
    "SELECT processing_status FROM external_event_inbox WHERE run_id=$1 ORDER BY source_sequence",
    [ids.run],
  );
  assert.deepEqual(inbox.rows.map((row) => row.processing_status), ["applied", "applied"]);
});

integrationTest("P7 PostgreSQL operator command is replay-safe and audited", async () => {
  const repository = new PostgresExecutionControlRepository(pool);
  const service = new ExecutionControlService({
    repository,
    authorizer: { async authorize() {} },
  });
  const command = {
    operation: "pause",
    scopeType: "project",
    scopeId: ids.project,
    actorId: "p7-operator",
    requestId: "p7-control-request",
    idempotencyKey: `p7-control-${ids.project}`,
    expectedVersion: 1,
    reason: "PostgreSQL integration pause drill",
  };
  const first = await service.execute(command);
  assert.deepEqual(await service.execute({ ...command, requestId: "retry" }), first);
  const rows = await pool.query(
    "SELECT count(*)::integer AS count FROM execution_command_receipts WHERE scope_key=$1",
    [ids.project],
  );
  assert.equal(rows.rows[0].count, 1);
});

integrationTest("P7 PostgreSQL admission atomically creates one Run and Job", async () => {
  const admittedAt = new Date();
  const source = new PostgresSchedulerAdmissionSource(pool);
  const candidates = await source.listReady({
    actorId: "p7-scheduler",
    now: admittedAt,
    maxAttempts: 3,
    maxRuntimeSeconds: 1800,
    maxCostUsd: 5,
    limit: 10,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].externalTaskId, "H-7001");
  assert.equal(candidates[0].requiredCapability, "general_coding");
  const service = new SchedulerAdmissionService({
    repository: new PostgresSchedulerAdmissionRepository(pool),
    authorizer: { async authorize() {} },
  });
  const command = candidates[0];
  const [first, concurrentReplay] = await Promise.all([
    service.admit(command),
    service.admit({ ...command, requestId: "p7-admission-concurrent-retry" }),
  ]);
  assert.deepEqual(concurrentReplay, first);
  assert.deepEqual(await service.admit({
    ...command,
    requestId: "p7-admission-retry",
    budget: { maxCostUsd: 5, maxRuntimeSeconds: 1800 },
  }), first);

  const stored = await pool.query(
    `SELECT run.id AS run_id,job.id AS job_id,run.attempt,job.external_task_id,
            job.required_capability,
            issue.status AS issue_status
       FROM runs run
       JOIN scheduler_jobs job ON job.run_id=run.id
       JOIN issues issue ON issue.id=run.issue_id
      WHERE run.issue_id=$1`,
    [ids.admissionIssue],
  );
  assert.equal(stored.rowCount, 1);
  assert.deepEqual(stored.rows[0], {
    run_id: first.runId,
    job_id: first.jobId,
    attempt: 1,
    external_task_id: "H-7001",
    required_capability: "general_coding",
    issue_status: "in_progress",
  });
  const audit = await pool.query(
    "SELECT count(*)::integer AS count FROM audit_events WHERE entity_id=$1",
    [first.jobId],
  );
  assert.equal(audit.rows[0].count, 1);
});
