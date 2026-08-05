import { createHash, randomUUID } from "node:crypto";

import type { PostgresPool } from "./postgres-goal-repository.ts";
import { canonicalJson } from "../domain/spec-artifact.ts";
import type {
  SchedulerAdmissionCommand,
  SchedulerAdmissionReceipt,
  SchedulerAdmissionRepository,
} from "../ports/scheduler-admission-repository.ts";

function requestHash(command: SchedulerAdmissionCommand): string {
  return createHash("sha256").update(canonicalJson({
    organizationId: command.organizationId,
    projectId: command.projectId,
    goalId: command.goalId,
    issueId: command.issueId,
    externalTaskId: command.externalTaskId,
    requiredCapability: command.requiredCapability,
    actorId: command.actorId,
    reason: command.reason,
    deadlineAt: command.deadlineAt,
    maxAttempts: command.maxAttempts,
    budget: command.budget,
  })).digest("hex");
}

function receipt(payload: unknown): SchedulerAdmissionReceipt | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).receipt;
  return value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value as SchedulerAdmissionReceipt)
    : null;
}

export class PostgresSchedulerAdmissionRepository implements SchedulerAdmissionRepository {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async admit(command: SchedulerAdmissionCommand): Promise<SchedulerAdmissionReceipt> {
    const hash = requestHash(command);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{
        request_hash: string;
        payload: unknown;
      }>(
        `SELECT idem.request_hash,outbox.payload
           FROM idempotency_records idem
           LEFT JOIN outbox_events outbox ON outbox.id::text=idem.response_ref
          WHERE idem.organization_id=$1 AND idem.actor_id=$2
            AND idem.endpoint='scheduler.admit' AND idem.key=$3
          FOR UPDATE OF idem`,
        [command.organizationId, command.actorId, command.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== hash) {
          throw new Error("Scheduler admission idempotency conflict");
        }
        const replay = receipt(existing.rows[0].payload);
        if (!replay) throw new Error("Scheduler admission is still in progress");
        await client.query("COMMIT");
        return replay;
      }
      await client.query(
        `INSERT INTO idempotency_records
          (organization_id,actor_id,endpoint,key,request_hash,expires_at)
         VALUES ($1,$2,'scheduler.admit',$3,$4,CURRENT_TIMESTAMP+interval '24 hours')`,
        [command.organizationId, command.actorId, command.idempotencyKey, hash],
      );
      const issue = await client.query<{ status: string; version: number }>(
        `SELECT status,version FROM issues
          WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND goal_id=$4
          FOR UPDATE`,
        [command.issueId, command.organizationId, command.projectId, command.goalId],
      );
      if (issue.rows[0]?.status !== "ready") {
        throw new Error("Only a dependency-ready Issue can be admitted");
      }
      const blocked = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
           FROM issue_dependencies edge
           JOIN issues dependency ON dependency.id=edge.depends_on_issue_id
          WHERE edge.organization_id=$1 AND edge.project_id=$2
            AND edge.goal_id=$3 AND edge.issue_id=$4
            AND dependency.status <> 'completed'`,
        [command.organizationId, command.projectId, command.goalId, command.issueId],
      );
      if (Number(blocked.rows[0]?.count ?? 0) > 0) {
        throw new Error("Issue dependencies are not completed");
      }
      const attempt = await client.query<{ attempt: number }>(
        `SELECT COALESCE(max(attempt),0)::integer+1 AS attempt
           FROM runs WHERE organization_id=$1 AND project_id=$2
             AND goal_id=$3 AND issue_id=$4`,
        [command.organizationId, command.projectId, command.goalId, command.issueId],
      );
      const admittedAt = new Date();
      if (new Date(command.deadlineAt) <= admittedAt) {
        throw new Error("Scheduler admission deadline must be in the future");
      }
      const runId = randomUUID();
      const jobId = randomUUID();
      const eventId = randomUUID();
      const attemptNumber = attempt.rows[0].attempt;
      const result: SchedulerAdmissionReceipt = {
        runId,
        jobId,
        issueId: command.issueId,
        attempt: attemptNumber,
        admittedAt: admittedAt.toISOString(),
      };
      await client.query(
        `INSERT INTO runs
          (id,organization_id,project_id,goal_id,issue_id,attempt,status,request_id,
           created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$8)`,
        [
          runId, command.organizationId, command.projectId, command.goalId,
          command.issueId, attemptNumber, command.requestId, admittedAt,
        ],
      );
      await client.query(
        `INSERT INTO scheduler_jobs
          (id,organization_id,project_id,goal_id,issue_id,run_id,external_task_id,
           required_capability,max_attempts,budget,deadline_at,next_attempt_at,
           created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12,$12)`,
        [
          jobId, command.organizationId, command.projectId, command.goalId,
          command.issueId, runId, command.externalTaskId,
          command.requiredCapability, command.maxAttempts,
          JSON.stringify(command.budget), new Date(command.deadlineAt), admittedAt,
        ],
      );
      const issueUpdated = await client.query(
        `UPDATE issues SET status='in_progress',version=version+1,
                           updated_at=GREATEST($1,created_at)
          WHERE id=$2 AND version=$3 AND status='ready'`,
        [admittedAt, command.issueId, issue.rows[0].version],
      );
      if (issueUpdated.rowCount !== 1) throw new Error("Issue changed during admission");
      await client.query(
        `INSERT INTO audit_events
          (id,organization_id,project_id,goal_id,actor_id,action,entity_type,
           entity_id,entity_version,reason,request_id,retention_until,created_at)
         VALUES ($1,$2,$3,$4,$5,'scheduler.job_admitted','scheduler_job',$6,1,
                 $7,$8,$9,$10)`,
        [
          randomUUID(), command.organizationId, command.projectId, command.goalId,
          command.actorId, jobId, command.reason, command.requestId,
          new Date(admittedAt.getTime() + 180 * 24 * 60 * 60 * 1000), admittedAt,
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
          (id,organization_id,aggregate_type,aggregate_id,aggregate_version,
           event_type,deduplication_key,payload)
         VALUES ($1,$2,'scheduler_job',$3,1,'scheduler.job_admitted',$4,$5::jsonb)`,
        [
          eventId, command.organizationId, jobId, `scheduler-admit:${jobId}`,
          JSON.stringify({ receipt: result, externalTaskId: command.externalTaskId }),
        ],
      );
      await client.query(
        `UPDATE idempotency_records
            SET status='completed',response_status=201,response_ref=$1,
                response_digest=$2,updated_at=GREATEST($3,created_at)
          WHERE organization_id=$4 AND actor_id=$5
            AND endpoint='scheduler.admit' AND key=$6`,
        [
          eventId, createHash("sha256").update(JSON.stringify(result)).digest("hex"),
          admittedAt, command.organizationId, command.actorId,
          command.idempotencyKey,
        ],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (
        (error as { code?: string; constraint?: string }).code === "23505" &&
        (error as { constraint?: string }).constraint ===
          "idempotency_records_scope_key_uidx"
      ) {
        return await this.admit(command);
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
