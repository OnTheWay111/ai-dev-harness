import { randomUUID } from "node:crypto";

import type { PostgresPool } from "./postgres-goal-repository.ts";
import type { RunStatus } from "../domain/state-machines.ts";
import type {
  AutoDevRunEventV1,
  EventIngestResult,
  ExecutionEventRepository,
  ExecutionRunProjection,
} from "../ports/execution-event-repository.ts";

interface ContextRow {
  job_id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  issue_id: string;
  run_id: string;
  external_run_id: string;
  external_task_id: string;
  run_status: RunStatus;
  phase: string;
  run_version: number;
  last_event_sequence: number;
  reconciliation_required: boolean;
}

interface PendingRow {
  id: string;
  source_sequence: number;
  phase: string;
  external_status: string;
  payload: AutoDevRunEventV1;
}

function mapProjection(row: ContextRow): ExecutionRunProjection {
  return {
    id: row.run_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    issueId: row.issue_id,
    externalRunId: row.external_run_id,
    externalTaskId: row.external_task_id,
    status: row.run_status,
    phase: row.phase,
    version: row.run_version,
    lastEventSequence: row.last_event_sequence,
    reconciliationRequired: row.reconciliation_required,
  };
}

function targetStatus(event: AutoDevRunEventV1): RunStatus | null {
  const status = event.status.toLowerCase();
  const phase = event.phase.toLowerCase();
  if (["succeeded", "done", "completed", "complete"].includes(status) || phase === "complete") {
    return "succeeded";
  }
  if (["failed", "error", "blocked"].includes(status)) return "failed";
  if (["cancelled", "canceled", "stopped"].includes(status)) return "cancelled";
  if (
    ["running", "in_progress", "started"].includes(status) ||
    ["claim", "worktree", "prompt", "builder", "verify", "review", "landing"].includes(phase)
  ) return "running";
  return null;
}

function terminal(status: RunStatus): boolean {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

export class PostgresExecutionEventRepository implements ExecutionEventRepository {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async ingest(input: {
    event: AutoDevRunEventV1;
    digest: string;
  }): Promise<EventIngestResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ source_event_digest: string }>(
        `SELECT source_event_digest FROM external_event_inbox
          WHERE source='autodev' AND source_event_id=$1`,
        [input.event.sourceEventId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return existing.rows[0].source_event_digest === input.digest
          ? { disposition: "duplicate" }
          : { disposition: "conflict", existingDigest: existing.rows[0].source_event_digest };
      }
      const contextResult = await client.query<ContextRow>(
        `SELECT job.id AS job_id, job.organization_id, job.project_id, job.goal_id,
                job.issue_id, job.run_id, job.external_run_id, job.external_task_id,
                run.status AS run_status,
                job.phase, run.version AS run_version, job.last_event_sequence,
                job.reconciliation_required
           FROM scheduler_jobs job
           JOIN runs run ON run.id=job.run_id
          WHERE job.external_run_id=$1
          FOR UPDATE OF job,run`,
        [input.event.externalRunId],
      );
      const context = contextResult.rows[0];
      if (!context) {
        await client.query("ROLLBACK");
        return { disposition: "run_not_found" };
      }
      if (context.external_task_id !== input.event.externalTaskId) {
        await client.query("ROLLBACK");
        return { disposition: "identity_mismatch" };
      }
      const observed = input.event.observability;
      if (observed && (
        observed.runId !== context.run_id ||
        observed.goalId !== context.goal_id ||
        observed.issueId !== context.issue_id
      )) {
        await client.query("ROLLBACK");
        return { disposition: "identity_mismatch" };
      }
      const inboxId = randomUUID();
      await client.query(
        `INSERT INTO external_event_inbox
          (id,organization_id,job_id,run_id,schema_version,source,source_event_id,
           source_event_digest,external_run_id,external_task_id,source_sequence,
           phase,external_status,payload,processing_status)
         VALUES ($1,$2,$3,$4,$5,'autodev',$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'pending')`,
        [
          inboxId, context.organization_id, context.job_id, context.run_id,
          input.event.schemaVersion, input.event.sourceEventId, input.digest,
          input.event.externalRunId, input.event.externalTaskId, input.event.sequence,
          input.event.phase, input.event.status, JSON.stringify(input.event),
        ],
      );
      if (input.event.sequence > context.last_event_sequence + 1) {
        await client.query(
          `UPDATE external_event_inbox SET processing_status='gap' WHERE id=$1`,
          [inboxId],
        );
        await client.query(
          `UPDATE scheduler_jobs
              SET reconciliation_required=true, version=version+1,
                  updated_at=CURRENT_TIMESTAMP
            WHERE id=$1`,
          [context.job_id],
        );
        await client.query("COMMIT");
        return {
          disposition: "gap",
          run: { ...mapProjection(context), reconciliationRequired: true },
        };
      }
      if (input.event.sequence <= context.last_event_sequence) {
        await client.query(
          `UPDATE external_event_inbox
              SET processing_status='terminal_ignored', processed_at=CURRENT_TIMESTAMP
            WHERE id=$1`,
          [inboxId],
        );
        await client.query("COMMIT");
        return { disposition: "terminal_ignored", run: mapProjection(context) };
      }

      let disposition: "applied" | "terminal_ignored" = "applied";
      for (;;) {
        const pending = await client.query<PendingRow>(
          `SELECT id,source_sequence,phase,external_status,payload
             FROM external_event_inbox
            WHERE job_id=$1 AND source_sequence=$2
              AND processing_status IN ('pending','gap')
            FOR UPDATE`,
          [context.job_id, context.last_event_sequence + 1],
        );
        const next = pending.rows[0];
        if (!next) break;
        const nextEvent = next.payload;
        context.phase = next.phase;
        context.last_event_sequence = next.source_sequence;
        if (terminal(context.run_status)) {
          disposition = "terminal_ignored";
          await client.query(
            `UPDATE external_event_inbox
                SET processing_status='terminal_ignored', processed_at=CURRENT_TIMESTAMP
              WHERE id=$1`,
            [next.id],
          );
          continue;
        }
        const target = targetStatus(nextEvent);
        if (target && target !== context.run_status) {
          if (context.run_status === "queued" && target !== "running") {
            await this.transitionRun(client, context, "running", nextEvent);
          }
          if (target !== context.run_status) {
            await this.transitionRun(client, context, target, nextEvent);
          }
        }
        await client.query(
          `UPDATE external_event_inbox
              SET processing_status='applied', processed_at=CURRENT_TIMESTAMP
            WHERE id=$1`,
          [next.id],
        );
      }
      const gaps = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM external_event_inbox
            WHERE job_id=$1 AND processing_status='gap'
              AND source_sequence > $2
         ) AS exists`,
        [context.job_id, context.last_event_sequence],
      );
      context.reconciliation_required = gaps.rows[0]?.exists ?? false;
      const jobState = context.run_status === "queued" ? "running" : context.run_status;
      await client.query(
        `UPDATE scheduler_jobs
            SET phase=$1,last_event_sequence=$2,reconciliation_required=$3,state=$4,
                version=version+1,updated_at=CURRENT_TIMESTAMP
          WHERE id=$5`,
        [
          context.phase, context.last_event_sequence,
          context.reconciliation_required, jobState, context.job_id,
        ],
      );
      if (terminal(context.run_status)) {
        await client.query(
          `UPDATE execution_leases
              SET status='released',released_at=CURRENT_TIMESTAMP,version=version+1
            WHERE run_id=$1 AND status='active'`,
          [context.run_id],
        );
      }
      await client.query("COMMIT");
      return { disposition, run: mapProjection(context) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") {
        const existing = await this.pool.query<{ source_event_digest: string }>(
          `SELECT source_event_digest FROM external_event_inbox
            WHERE source='autodev' AND source_event_id=$1`,
          [input.event.sourceEventId],
        );
        return existing.rows[0]?.source_event_digest === input.digest
          ? { disposition: "duplicate" }
          : { disposition: "conflict", existingDigest: existing.rows[0]?.source_event_digest };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async transitionRun(
    client: Awaited<ReturnType<PostgresPool["connect"]>>,
    context: ContextRow,
    status: RunStatus,
    event: AutoDevRunEventV1,
  ): Promise<void> {
    const updated = await client.query<{ version: number }>(
      `UPDATE runs
          SET status=$1,
              started_at=CASE WHEN $1='running' THEN COALESCE(started_at,$2) ELSE started_at END,
              finished_at=CASE WHEN $1 IN ('succeeded','failed','cancelled') THEN $2 ELSE NULL END,
              version=version+1,updated_at=$2
        WHERE id=$3 AND status=$4
      RETURNING version`,
      [status, new Date(event.occurredAt), context.run_id, context.run_status],
    );
    if (!updated.rows[0]) throw new Error("Run changed during external event mapping");
    context.run_status = status;
    context.run_version = updated.rows[0].version;
    await client.query(
      `INSERT INTO outbox_events
        (id,organization_id,aggregate_type,aggregate_id,aggregate_version,
         event_type,deduplication_key,payload)
       VALUES ($1,$2,'run',$3,$4,$5,$6,$7::jsonb)`,
      [
        randomUUID(), context.organization_id, context.run_id, context.run_version,
        status === "running" ? "run.started" : `run.${status}`,
        `autodev:${event.sourceEventId}:${status}`,
        JSON.stringify({
          sourceEventId: event.sourceEventId,
          sourceSequence: event.sequence,
          externalRunId: event.externalRunId,
          phase: event.phase,
          status,
        }),
      ],
    );
  }
}
