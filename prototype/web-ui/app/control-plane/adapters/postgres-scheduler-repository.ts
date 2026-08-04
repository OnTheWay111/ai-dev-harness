import { createHash, randomUUID } from "node:crypto";

import type { PostgresPool } from "./postgres-goal-repository.ts";
import type {
  ExecutionLeaseRecord,
  ExecutionNodeRecord,
  SchedulerJob,
  SchedulerJobState,
  SchedulerRepository,
} from "../ports/scheduler-repository.ts";
import type { CapabilityTier } from "../domain/model-router.ts";

interface JobRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  run_id: string;
  external_task_id: string;
  required_capability: CapabilityTier;
  state: SchedulerJobState;
  phase: string;
  priority: number;
  attempt: number;
  max_attempts: number;
  budget: Record<string, unknown>;
  deadline_at: Date;
  next_attempt_at: Date;
  external_run_id: string | null;
  node_id: string | null;
  lease_token_digest: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  last_event_sequence: number;
  reconciliation_required: boolean;
  failure_code: string | null;
  failure_reason: string | null;
  stop_requested?: boolean;
  version: number;
}

interface NodeRow {
  id: string;
  name: string;
  provider: string;
  capabilities: string[];
  max_concurrent_runs: number;
  status: "online" | "draining" | "offline";
  heartbeat_at: Date;
  offline_after: Date;
  version: number;
}

interface LeaseRow {
  id: string;
  run_id: string;
  node_id: string;
  owner_id: string;
  token_digest: string;
  status: "active" | "released" | "expired";
  acquired_at: Date;
  heartbeat_at: Date;
  expires_at: Date;
  released_at: Date | null;
  version: number;
}

const jobColumns = `
  id, organization_id, project_id, goal_id, run_id, external_task_id, required_capability,
  state, phase, priority, attempt, max_attempts, budget, deadline_at, next_attempt_at,
  external_run_id, node_id, lease_token_digest, lease_expires_at, heartbeat_at,
  last_event_sequence, reconciliation_required, failure_code, failure_reason,
  version`;

function mapJob(row: JobRow): SchedulerJob {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    runId: row.run_id,
    externalTaskId: row.external_task_id,
    requiredCapability: row.required_capability,
    state: row.state,
    phase: row.phase,
    priority: row.priority,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    budget: row.budget,
    deadlineAt: row.deadline_at.toISOString(),
    nextAttemptAt: row.next_attempt_at.toISOString(),
    externalRunId: row.external_run_id,
    nodeId: row.node_id,
    leaseToken: null,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
    lastEventSequence: row.last_event_sequence,
    reconciliationRequired: row.reconciliation_required,
    stopRequested: row.stop_requested ?? false,
    failureCode: row.failure_code ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    version: row.version,
  };
}

function mapNode(row: NodeRow): ExecutionNodeRecord {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    capabilities: row.capabilities,
    maxConcurrentRuns: row.max_concurrent_runs,
    status: row.status,
    heartbeatAt: row.heartbeat_at.toISOString(),
    offlineAfter: row.offline_after.toISOString(),
    version: row.version,
  };
}

function mapLease(row: LeaseRow, token: string): ExecutionLeaseRecord {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    ownerId: row.owner_id,
    token,
    status: row.status,
    acquiredAt: row.acquired_at.toISOString(),
    heartbeatAt: row.heartbeat_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    releasedAt: row.released_at?.toISOString() ?? null,
    version: row.version,
  };
}

function leaseDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mappedState(state: string): SchedulerJobState {
  if (state === "succeeded") return "succeeded";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  if (state === "unknown") return "blocked";
  return "running";
}

export class PostgresSchedulerRepository implements SchedulerRepository {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async registerNode(input: {
    id: string;
    name: string;
    provider: string;
    capabilities: readonly string[];
    maxConcurrentRuns: number;
    now: Date;
    offlineAfter: Date;
  }): Promise<ExecutionNodeRecord> {
    const result = await this.pool.query<NodeRow>(
      `INSERT INTO execution_nodes
        (id,name,provider,capabilities,max_concurrent_runs,status,
         heartbeat_at,offline_after,created_at,updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,'online',$6,$7,$6,$6)
       ON CONFLICT (id) DO UPDATE
         SET name=EXCLUDED.name,provider=EXCLUDED.provider,
             capabilities=EXCLUDED.capabilities,
             max_concurrent_runs=EXCLUDED.max_concurrent_runs,status='online',
             heartbeat_at=EXCLUDED.heartbeat_at,offline_after=EXCLUDED.offline_after,
             version=execution_nodes.version+1,updated_at=EXCLUDED.updated_at
       RETURNING id,name,provider,capabilities,max_concurrent_runs,status,
                 heartbeat_at,offline_after,version`,
      [
        input.id, input.name, input.provider, JSON.stringify(input.capabilities),
        input.maxConcurrentRuns, input.now, input.offlineAfter,
      ],
    );
    return mapNode(result.rows[0]);
  }

  async listExternalRuns(): Promise<readonly {
    externalRunId: string;
    externalTaskId: string;
  }[]> {
    const result = await this.pool.query<{
      external_run_id: string;
      external_task_id: string;
    }>(
      `SELECT external_run_id,external_task_id FROM scheduler_jobs
        WHERE external_run_id IS NOT NULL
          AND state NOT IN ('succeeded','failed','cancelled','blocked')
        ORDER BY updated_at,id`,
      [],
    );
    return result.rows.map((row) => ({
      externalRunId: row.external_run_id,
      externalTaskId: row.external_task_id,
    }));
  }

  async listForReconciliation(now: Date): Promise<readonly SchedulerJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const offline = await client.query<{ id: string }>(
        `UPDATE execution_nodes
            SET status='offline', version=version+1, updated_at=$1
          WHERE status <> 'offline' AND offline_after <= $1
        RETURNING id`,
        [now],
      );
      const expired = await client.query<{ run_id: string }>(
        `UPDATE execution_leases
            SET status='expired', released_at=$1, version=version+1
          WHERE status='active'
            AND (expires_at <= $1 OR node_id=ANY($2::uuid[]))
        RETURNING run_id`,
        [now, offline.rows.map((row) => row.id)],
      );
      if (expired.rows.length > 0) {
        const affected = await client.query<{
          id: string;
          organization_id: string;
          run_id: string;
          version: number;
        }>(
          `UPDATE scheduler_jobs
              SET reconciliation_required=true, version=version+1, updated_at=$1
            WHERE run_id = ANY($2::uuid[])
              AND state NOT IN ('succeeded','failed','cancelled','blocked')
          RETURNING id,organization_id,run_id,version`,
          [now, expired.rows.map((row) => row.run_id)],
        );
        for (const job of affected.rows) {
          await client.query(
            `INSERT INTO outbox_events
              (id,organization_id,aggregate_type,aggregate_id,aggregate_version,
               event_type,deduplication_key,payload)
             VALUES ($1,$2,'scheduler_job',$3,$4,'execution.lease_expired',$5,$6::jsonb)`,
            [
              randomUUID(), job.organization_id, job.id, job.version,
              `lease-expired:${job.id}:${job.version}`,
              JSON.stringify({ runId: job.run_id, detectedAt: now.toISOString() }),
            ],
          );
        }
      }
      const result = await client.query<JobRow>(
        `SELECT ${jobColumns},
                EXISTS (
                  SELECT 1 FROM execution_controls control
                   WHERE control.state='stopped'
                     AND ((control.scope_type='global' AND control.scope_key='global')
                       OR (control.scope_type='project'
                         AND control.scope_key=scheduler_jobs.project_id::text))
                ) AS stop_requested
           FROM scheduler_jobs
          WHERE state NOT IN ('succeeded','failed','cancelled','blocked')
            AND (EXISTS (
                   SELECT 1 FROM execution_controls control
                    WHERE control.state='stopped'
                      AND ((control.scope_type='global' AND control.scope_key='global')
                        OR (control.scope_type='project'
                          AND control.scope_key=scheduler_jobs.project_id::text))
                 ) OR reconciliation_required=true OR
                 (state IN ('starting','running','reconciling') AND deadline_at <= $1))
          ORDER BY updated_at, id
          FOR UPDATE SKIP LOCKED`,
        [now],
      );
      await client.query("COMMIT");
      return result.rows.map(mapJob);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeatOwned(input: {
    ownerId: string;
    now: Date;
    expiresAt: Date;
  }): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const leases = await client.query<{ run_id: string }>(
        `UPDATE execution_leases
            SET heartbeat_at=$1,expires_at=$2,version=version+1
          WHERE owner_id=$3 AND status='active' AND expires_at > $1
        RETURNING run_id`,
        [input.now, input.expiresAt, input.ownerId],
      );
      if (leases.rows.length > 0) {
        await client.query(
          `UPDATE scheduler_jobs
              SET heartbeat_at=$1,lease_expires_at=$2,updated_at=$1
            WHERE run_id = ANY($3::uuid[])
              AND state NOT IN ('succeeded','failed','cancelled','blocked')`,
          [input.now, input.expiresAt, leases.rows.map((row) => row.run_id)],
        );
      }
      await client.query("COMMIT");
      return leases.rows.length;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(now: Date, _supervisorId: string): Promise<SchedulerJob | null> {
    void _supervisorId; // Ownership becomes authoritative only after the lease transaction.
    const result = await this.pool.query<JobRow>(
      `WITH candidate AS (
         SELECT id
           FROM scheduler_jobs
          WHERE state IN ('pending','retry_wait')
            AND reconciliation_required=false
            AND next_attempt_at <= $1 AND deadline_at > $1
            AND NOT EXISTS (
              SELECT 1 FROM execution_controls control
               WHERE (
                 (control.scope_type='global' AND control.scope_key='global')
                 OR (control.scope_type='project' AND control.scope_key=scheduler_jobs.project_id::text)
               )
                 AND (control.state <> 'active' OR control.circuit_open_until > $1)
            )
          ORDER BY priority, next_attempt_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE scheduler_jobs job
          SET state='claimed', heartbeat_at=$1, failure_reason=NULL,
              version=job.version+1, updated_at=$1
         FROM candidate
        WHERE job.id=candidate.id
       RETURNING ${jobColumns.replace(/\b(id|organization_id|project_id|goal_id|run_id|external_task_id|required_capability|state|phase|priority|attempt|max_attempts|budget|deadline_at|next_attempt_at|external_run_id|node_id|lease_token_digest|lease_expires_at|heartbeat_at|last_event_sequence|reconciliation_required|failure_code|failure_reason|version)\b/g, "job.$1")}`,
      [now],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async selectNode(job: SchedulerJob, now: Date): Promise<ExecutionNodeRecord | null> {
    const result = await this.pool.query<NodeRow>(
      `SELECT node.id, node.name, node.provider, node.capabilities,
              node.max_concurrent_runs, node.status, node.heartbeat_at,
              node.offline_after, node.version
         FROM execution_nodes node
         LEFT JOIN execution_leases lease
           ON lease.node_id=node.id AND lease.status='active' AND lease.expires_at > $1
        WHERE node.status='online' AND node.offline_after > $1
          AND node.capabilities @> $2::jsonb
        GROUP BY node.id
       HAVING count(lease.id) < node.max_concurrent_runs
        ORDER BY count(lease.id), node.name
        LIMIT 1`,
      [now, JSON.stringify([job.requiredCapability])],
    );
    return result.rows[0] ? mapNode(result.rows[0]) : null;
  }

  async acquireLease(input: {
    runId: string;
    nodeId: string;
    ownerId: string;
    now: Date;
    expiresAt: Date;
  }): Promise<ExecutionLeaseRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const node = await client.query<NodeRow>(
        `SELECT id, name, provider, capabilities, max_concurrent_runs, status,
                heartbeat_at, offline_after, version
           FROM execution_nodes WHERE id=$1 FOR UPDATE`,
        [input.nodeId],
      );
      const selected = node.rows[0];
      if (!selected || selected.status !== "online" || selected.offline_after <= input.now) {
        await client.query("ROLLBACK");
        return null;
      }
      const job = await client.query<{ required_capability: CapabilityTier }>(
        `SELECT required_capability FROM scheduler_jobs
          WHERE run_id=$1 FOR UPDATE`,
        [input.runId],
      );
      if (
        !job.rows[0] ||
        !selected.capabilities.includes(job.rows[0].required_capability)
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `UPDATE execution_leases
            SET status='expired', released_at=$1, version=version+1
          WHERE status='active' AND expires_at <= $1
            AND (node_id=$2 OR run_id=$3)`,
        [input.now, input.nodeId, input.runId],
      );
      const owner = await client.query(
        `SELECT id FROM execution_leases WHERE run_id=$1 AND status='active'`,
        [input.runId],
      );
      if (owner.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const capacity = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
           FROM execution_leases
          WHERE node_id=$1 AND status='active' AND expires_at > $2`,
        [input.nodeId, input.now],
      );
      if (Number(capacity.rows[0]?.count ?? 0) >= selected.max_concurrent_runs) {
        await client.query("ROLLBACK");
        return null;
      }
      const token = randomUUID();
      const inserted = await client.query<LeaseRow>(
        `INSERT INTO execution_leases
          (run_id,node_id,owner_id,token_digest,status,acquired_at,heartbeat_at,expires_at)
         VALUES ($1,$2,$3,$4,'active',$5,$5,$6)
         RETURNING id,run_id,node_id,owner_id,token_digest,status,acquired_at,
                   heartbeat_at,expires_at,released_at,version`,
        [
          input.runId, input.nodeId, input.ownerId, leaseDigest(token), input.now,
          input.expiresAt,
        ],
      );
      await client.query("COMMIT");
      return mapLease(inserted.rows[0], token);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") return null;
      throw error;
    } finally {
      client.release();
    }
  }

  async markExternalStartIssued(input: {
    jobId: string;
    expectedVersion: number;
    externalRunId: string;
    lease: ExecutionLeaseRecord;
    now: Date;
  }): Promise<SchedulerJob> {
    const result = await this.pool.query<JobRow>(
      `UPDATE scheduler_jobs
          SET state='starting', external_run_id=$1, node_id=$2,
              lease_token_digest=$3, lease_expires_at=$4, heartbeat_at=$5,
              reconciliation_required=true, version=version+1, updated_at=$5
        WHERE id=$6 AND state='claimed' AND version=$7
      RETURNING ${jobColumns}`,
      [
        input.externalRunId, input.lease.nodeId, leaseDigest(input.lease.token),
        input.lease.expiresAt, input.now, input.jobId, input.expectedVersion,
      ],
    );
    if (!result.rows[0]) throw new Error("scheduler job version conflict");
    return mapJob(result.rows[0]);
  }

  async markStarted(jobId: string, external: {
    state: string;
    phase: string;
  }, now: Date): Promise<SchedulerJob> {
    return await this.commitExternalState(jobId, external, now);
  }

  async reconcileExternal(jobId: string, external: {
    state: string;
    phase: string;
    message?: string;
  } | null, now: Date): Promise<SchedulerJob> {
    return await this.commitExternalState(jobId, external ?? {
      state: "unknown", phase: "unknown", message: "External state unavailable",
    }, now);
  }

  async markTimedOut(jobId: string, now: Date): Promise<SchedulerJob> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<JobRow>(
        `UPDATE scheduler_jobs
            SET state='failed', phase='timeout', failure_code='deadline_exceeded',
                failure_reason='Execution deadline exceeded',
                reconciliation_required=false, heartbeat_at=$1,
                version=version+1, updated_at=$1
          WHERE id=$2 AND state NOT IN ('succeeded','failed','cancelled','blocked')
        RETURNING ${jobColumns}`,
        [now, jobId],
      );
      if (!result.rows[0]) throw new Error("scheduler job is already terminal");
      await client.query(
        `UPDATE execution_leases
            SET status='released', released_at=$1, version=version+1
          WHERE run_id=$2 AND status='active'`,
        [now, result.rows[0].run_id],
      );
      await this.updateRunAndOutbox(client, result.rows[0], "failed", now);
      await client.query("COMMIT");
      return mapJob(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markStopped(jobId: string, now: Date): Promise<SchedulerJob> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<JobRow>(
        `UPDATE scheduler_jobs
            SET state='cancelled', phase='stopped', failure_code='operator_stop',
                failure_reason='Execution stopped by operator control',
                reconciliation_required=false, heartbeat_at=$1,
                version=version+1, updated_at=$1
          WHERE id=$2 AND state NOT IN ('succeeded','failed','cancelled','blocked')
        RETURNING ${jobColumns}`,
        [now, jobId],
      );
      if (!result.rows[0]) throw new Error("scheduler job is already terminal");
      await client.query(
        `UPDATE execution_leases
            SET status='released', released_at=$1, version=version+1
          WHERE run_id=$2 AND status='active'`,
        [now, result.rows[0].run_id],
      );
      await this.updateRunAndOutbox(client, result.rows[0], "cancelled", now);
      await client.query("COMMIT");
      return mapJob(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async handleStartFailure(input: {
    jobId: string;
    failureCode: string;
    failureReason: string;
    now: Date;
  }): Promise<SchedulerJob> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<JobRow>(
        `UPDATE scheduler_jobs
            SET state=CASE WHEN attempt < max_attempts THEN 'retry_wait' ELSE 'failed' END,
                attempt=CASE WHEN attempt < max_attempts THEN attempt+1 ELSE attempt END,
                next_attempt_at=$1 + make_interval(secs => LEAST(60, power(2,attempt)::integer)),
                external_run_id=NULL,node_id=NULL,lease_token_digest=NULL,
                lease_expires_at=NULL,reconciliation_required=false,
                failure_code=$2,failure_reason=$3,version=version+1,updated_at=$1
          WHERE id=$4 AND state='starting'
        RETURNING ${jobColumns}`,
        [input.now, input.failureCode, input.failureReason, input.jobId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("scheduler start failure could not be recorded");
      await client.query(
        `UPDATE execution_leases
            SET status='released',released_at=$1,version=version+1
          WHERE run_id=$2 AND status='active'`,
        [input.now, row.run_id],
      );
      await client.query(
        `INSERT INTO execution_controls
          (organization_id,project_id,scope_type,scope_key,state,reason,
           consecutive_failures,circuit_open_until)
         VALUES ($1,$2,'project',$2::text,'active','Gateway failure circuit',1,NULL)
         ON CONFLICT (scope_type,scope_key) DO UPDATE
           SET consecutive_failures=execution_controls.consecutive_failures+1,
               circuit_open_until=CASE
                 WHEN execution_controls.consecutive_failures+1 >= 3
                   THEN $3 + interval '5 minutes'
                 ELSE execution_controls.circuit_open_until END,
               reason='Gateway failure circuit',version=execution_controls.version+1,
               updated_at=$3`,
        [row.organization_id, row.project_id, input.now],
      );
      if (row.state === "failed") {
        await this.updateRunAndOutbox(client, row, "failed", input.now);
      }
      await client.query("COMMIT");
      return mapJob(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseClaim(jobId: string, reason: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE scheduler_jobs
          SET state='pending', failure_reason=$1, next_attempt_at=$2,
              version=version+1, updated_at=$2
        WHERE id=$3 AND state='claimed'`,
      [reason, now, jobId],
    );
  }

  private async commitExternalState(
    jobId: string,
    external: { state: string; phase: string; message?: string },
    now: Date,
  ): Promise<SchedulerJob> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const state = mappedState(external.state);
      const result = await client.query<JobRow>(
        `UPDATE scheduler_jobs
            SET state=$1, phase=$2, failure_code=CASE WHEN $1='blocked' THEN 'external_state_unknown' WHEN $1='failed' THEN 'external_failed' ELSE NULL END,
                failure_reason=CASE WHEN $1 IN ('blocked','failed') THEN $3 ELSE NULL END,
                reconciliation_required=false, heartbeat_at=$4,
                version=version+1, updated_at=$4
          WHERE id=$5 AND state NOT IN ('succeeded','failed','cancelled','blocked')
        RETURNING ${jobColumns}`,
        [state, external.phase, external.message ?? null, now, jobId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("scheduler job is already terminal");
      if (["running", "succeeded", "failed", "cancelled"].includes(state)) {
        await this.updateRunAndOutbox(client, row, state, now);
      }
      if (["succeeded", "failed", "cancelled", "blocked"].includes(state)) {
        await client.query(
          `UPDATE execution_leases
              SET status='released', released_at=$1, version=version+1
            WHERE run_id=$2 AND status='active'`,
          [now, row.run_id],
        );
      }
      await client.query("COMMIT");
      return mapJob(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateRunAndOutbox(
    client: Awaited<ReturnType<PostgresPool["connect"]>>,
    job: JobRow,
    state: string,
    now: Date,
  ): Promise<void> {
    const runState = state === "running" ? "running" : state;
    const updated = await client.query<{ version: number; status: string }>(
      `UPDATE runs
          SET status=$1,
              started_at=CASE WHEN $1='running' THEN COALESCE(started_at,$2) ELSE COALESCE(started_at,$2) END,
              finished_at=CASE WHEN $1 IN ('succeeded','failed','cancelled') THEN $2 ELSE NULL END,
              version=version+1, updated_at=$2
        WHERE id=$3 AND status NOT IN ('succeeded','failed','cancelled')
          AND status <> $1
      RETURNING version,status`,
      [runState, now, job.run_id],
    );
    const run = updated.rows[0];
    if (!run) return;
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO outbox_events
        (id,organization_id,aggregate_type,aggregate_id,aggregate_version,
         event_type,deduplication_key,payload)
       VALUES ($1,$2,'run',$3,$4,$5,$6,$7::jsonb)`,
      [
        eventId, job.organization_id, job.run_id, run.version,
        run.status === "running" ? "run.started" : `run.${run.status}`,
        `scheduler:${job.id}:run:${run.version}`,
        JSON.stringify({ jobId: job.id, phase: job.phase, status: run.status }),
      ],
    );
  }
}
