import { expect, test } from "@playwright/test";

import pg from "pg";

import { PostgresExecutionControlRepository } from
  "../../app/control-plane/adapters/postgres-execution-control-repository";
import { PostgresExecutionEventRepository } from
  "../../app/control-plane/adapters/postgres-execution-event-repository";
import { ExecutionControlService } from
  "../../app/control-plane/application/execution-control-service";
import { ExternalEventService } from
  "../../app/control-plane/application/external-event-service";
import {
  p12OrganizationId,
  p12ProjectId,
} from "./p12-browser-auth";

const { Pool } = pg;

test("PostgreSQL pause, drain, recovery, and out-of-order events are replay-safe", async () => {
  const pool = new Pool({
    connectionString: process.env.P12_E2E_DATABASE_URL,
    max: 4,
  });
  const ids = {
    goal: crypto.randomUUID(),
    spec: crypto.randomUUID(),
    issue: crypto.randomUUID(),
    run: crypto.randomUUID(),
    job: crypto.randomUUID(),
  };
  const externalRunId = `p12-disorder-${ids.run}`;
  const createdAt = new Date();
  try {
    await pool.query(
      `INSERT INTO goals
        (id,organization_id,project_id,title,problem_statement,desired_outcome,
         created_at,updated_at)
       VALUES ($1,$2,$3,'P12 resilience fixture','Exercise failure paths',
               'Prove durable recovery',$4,$4)`,
      [ids.goal, p12OrganizationId, p12ProjectId, createdAt],
    );
    await pool.query(
      `INSERT INTO spec_revisions
        (id,organization_id,project_id,goal_id,revision,status,
         source_goal_version,artifact_ref,artifact_digest,generated_at,
         created_at,updated_at)
       VALUES ($1,$2,$3,$4,1,'approved',1,'artifact://p12-resilience',$5,
               $6,$6,$6)`,
      [
        ids.spec,
        p12OrganizationId,
        p12ProjectId,
        ids.goal,
        "a".repeat(64),
        createdAt,
      ],
    );
    await pool.query(
      `INSERT INTO issues
        (id,organization_id,project_id,goal_id,spec_revision_id,issue_key,
         revision,status,title,body_ref,body_digest,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'P12-RESILIENCE',1,'ready',
               'P12 resilience issue','artifact://p12-resilience-issue',$6,$7,$7)`,
      [
        ids.issue,
        p12OrganizationId,
        p12ProjectId,
        ids.goal,
        ids.spec,
        "b".repeat(64),
        createdAt,
      ],
    );
    await pool.query(
      `INSERT INTO runs
        (id,organization_id,project_id,goal_id,issue_id,attempt,status,
         request_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,1,'queued','p12-resilience',$6,$6)`,
      [
        ids.run,
        p12OrganizationId,
        p12ProjectId,
        ids.goal,
        ids.issue,
        createdAt,
      ],
    );
    await pool.query(
      `INSERT INTO scheduler_jobs
        (id,organization_id,project_id,goal_id,issue_id,run_id,
         external_task_id,external_run_id,state,deadline_at,next_attempt_at,
         max_attempts,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'H-P12-RESILIENCE',$7,'running',$8,$9,2,$10,$10)`,
      [
        ids.job,
        p12OrganizationId,
        p12ProjectId,
        ids.goal,
        ids.issue,
        ids.run,
        externalRunId,
        new Date(createdAt.getTime() + 60 * 60 * 1_000),
        createdAt,
        createdAt,
      ],
    );

    let tick = 0;
    const controls = new ExecutionControlService({
      repository: new PostgresExecutionControlRepository(pool),
      authorizer: { async authorize() {} },
      clock: () => new Date(createdAt.getTime() + (++tick * 1_000)),
    });
    const command = {
      scopeType: "project" as const,
      scopeId: p12ProjectId,
      actorId: "p12-resilience-operator",
      reason: "P12 controlled resilience drill",
    };
    const paused = await controls.execute({
      ...command,
      operation: "pause",
      requestId: "p12-pause",
      idempotencyKey: "p12-pause-replay-safe",
      expectedVersion: 1,
    });
    expect(await controls.execute({
      ...command,
      operation: "pause",
      requestId: "p12-pause-retry",
      idempotencyKey: "p12-pause-replay-safe",
      expectedVersion: 1,
    })).toEqual(paused);
    const drained = await controls.execute({
      ...command,
      operation: "drain",
      requestId: "p12-drain",
      idempotencyKey: "p12-drain-once",
      expectedVersion: 2,
    });
    expect(drained.state).toBe("draining");
    const resumed = await controls.execute({
      ...command,
      operation: "resume",
      requestId: "p12-resume",
      idempotencyKey: "p12-resume-once",
      expectedVersion: 3,
    });
    expect(resumed).toMatchObject({ state: "active", version: 4 });

    const events = new ExternalEventService({
      repository: new PostgresExecutionEventRepository(pool),
    });
    const event = (
      sequence: number,
      phase: string,
      status: string,
    ) => ({
      schemaVersion: "autodev.run-event.v1" as const,
      sourceEventId: `p12-resilience-event-${sequence}`,
      externalRunId,
      externalTaskId: "H-P12-RESILIENCE",
      sequence,
      occurredAt: new Date(createdAt.getTime() + 10_000 + sequence * 1_000)
        .toISOString(),
      phase,
      status,
      message: `P12 ${phase} ${status}`,
    });
    const second = event(2, "complete", "succeeded");
    expect((await events.ingest(second)).disposition).toBe("gap");
    expect((await events.ingest(second)).disposition).toBe("duplicate");
    expect((await events.ingest(event(1, "builder", "running"))).disposition)
      .toBe("applied");

    const proof = await pool.query(
      `SELECT
        (SELECT state FROM execution_controls
          WHERE scope_type='project' AND scope_key=$1) AS control_state,
        (SELECT count(*)::int FROM execution_command_receipts
          WHERE actor_id='p12-resilience-operator') AS control_receipts,
        (SELECT count(*)::int FROM outbox_events
          WHERE aggregate_type='execution_control'
            AND payload->>'actorId'='p12-resilience-operator') AS control_events,
        (SELECT status FROM runs WHERE id=$2) AS run_status,
        (SELECT last_event_sequence FROM scheduler_jobs WHERE id=$3) AS sequence,
        (SELECT reconciliation_required FROM scheduler_jobs WHERE id=$3)
          AS reconciliation_required,
        (SELECT count(*)::int FROM external_event_inbox WHERE run_id=$2)
          AS inbox_events,
        (SELECT count(*)::int FROM outbox_events
          WHERE aggregate_type='run' AND aggregate_id=$2) AS run_events`,
      [p12ProjectId, ids.run, ids.job],
    );
    expect(proof.rows[0]).toMatchObject({
      control_state: "active",
      control_receipts: 3,
      control_events: 3,
      run_status: "succeeded",
      sequence: 2,
      reconciliation_required: false,
      inbox_events: 2,
      run_events: 2,
    });
  } finally {
    await pool.end();
  }
});
