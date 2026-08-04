import { randomUUID } from "node:crypto";

import type { ActorVisibilityScope } from "../../auth/visibility-scope.ts";
import type { PostgresPool } from
  "../../control-plane/adapters/postgres-goal-repository.ts";
import type {
  CommandReceipt,
  GlobalTask,
} from "../contracts.ts";
import {
  TaskActionError,
  type AcceptTaskActionInput,
  type ScopedWorkbenchTask,
  type TaskActionRepository,
  type TransitionTaskReceiptInput,
} from "./task-action-repository.ts";

interface TaskRow {
  organization_id: string;
  project_id: string;
  payload: GlobalTask;
}

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed" | "failed";
  response_ref: string | null;
}

interface ReceiptRow {
  id: string;
  organization_id: string;
  project_id: string;
  task_id: string;
  request_id: string;
  status: CommandReceipt["status"];
  task_version: number;
  result_task_version: number | null;
  error: CommandReceipt["error"] | null;
  created_at: Date;
  completed_at: Date | null;
  version: number;
}

const receiptColumns = `
  id,organization_id,project_id,task_id,request_id,status,task_version,
  result_task_version,error,created_at,completed_at,version`;

function exposedReceiptId(uuid: string): string {
  return `rcpt_${uuid}`;
}

function receiptUuid(value: string): string | null {
  const match = /^rcpt_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(value);
  return match?.[1] ?? null;
}

function mapReceipt(row: ReceiptRow): CommandReceipt {
  const id = exposedReceiptId(row.id);
  return {
    receiptId: id,
    requestId: row.request_id,
    status: row.status,
    taskId: row.task_id,
    taskVersion: row.result_task_version ?? row.task_version,
    submittedAt: row.created_at.toISOString(),
    statusUrl: `/api/v1/receipts/${id}`,
    completedAt: row.completed_at?.toISOString(),
    error: row.error ?? undefined,
  };
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class PostgresTaskActionRepository implements TaskActionRepository {
  private readonly pool: PostgresPool;
  private readonly scopeId: string;

  constructor(input: { pool: PostgresPool; scopeId: string }) {
    this.pool = input.pool;
    this.scopeId = input.scopeId;
  }

  async findTask(
    taskId: string,
    visibility: ActorVisibilityScope,
  ): Promise<ScopedWorkbenchTask | null> {
    const result = await this.pool.query<TaskRow>(
      `SELECT organization_id,project_id,payload
         FROM workbench_tasks
        WHERE scope_id=$1 AND task_id=$2
          AND (
            organization_id=ANY($3::uuid[])
            OR project_id=ANY($4::uuid[])
          )
        ORDER BY organization_id,project_id
        LIMIT 2`,
      [
        this.scopeId,
        taskId,
        [...visibility.organizationIds],
        [...visibility.projectIds],
      ],
    );
    if (result.rows.length > 1) {
      throw new TaskActionError(
        "validation_failed",
        "Task ID is ambiguous in the visible scope",
      );
    }
    const row = result.rows[0];
    return row
      ? {
          organizationId: row.organization_id,
          projectId: row.project_id,
          task: structuredClone(row.payload),
        }
      : null;
  }

  async findIdempotent(input: {
    organizationId: string;
    actorId: string;
    endpoint: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<CommandReceipt | null> {
    const result = await this.pool.query<IdempotencyRow>(
      `SELECT request_hash,status,response_ref
         FROM idempotency_records
        WHERE organization_id=$1 AND actor_id=$2 AND endpoint=$3 AND key=$4`,
      [
        input.organizationId,
        input.actorId,
        input.endpoint,
        input.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.request_hash !== input.requestHash) {
      throw new TaskActionError(
        "idempotency_conflict",
        "Idempotency key is already used by another task command",
      );
    }
    if (row.status !== "completed" || !row.response_ref) {
      throw new TaskActionError(
        "invalid_transition",
        "The first task command is still being accepted",
      );
    }
    const uuid = receiptUuid(row.response_ref);
    if (!uuid) throw new Error("Task action idempotency response reference is invalid");
    const receipt = await this.pool.query<ReceiptRow>(
      `SELECT ${receiptColumns} FROM task_action_receipts WHERE id=$1`,
      [uuid],
    );
    if (!receipt.rows[0]) throw new Error("Task action receipt is missing");
    return mapReceipt(receipt.rows[0]);
  }

  async accept(input: AcceptTaskActionInput): Promise<CommandReceipt> {
    const client = await this.pool.connect();
    const endpoint = `/api/v1/tasks/${input.scopedTask.task.id}/actions`;
    try {
      await client.query("BEGIN");
      const replay = await client.query<IdempotencyRow>(
        `SELECT request_hash,status,response_ref
           FROM idempotency_records
          WHERE organization_id=$1 AND actor_id=$2 AND endpoint=$3 AND key=$4
          FOR UPDATE`,
        [
          input.scopedTask.organizationId,
          input.actorId,
          endpoint,
          input.idempotencyKey,
        ],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== input.requestHash) {
          throw new TaskActionError(
            "idempotency_conflict",
            "Idempotency key is already used by another task command",
          );
        }
        const uuid = replay.rows[0].response_ref
          ? receiptUuid(replay.rows[0].response_ref)
          : null;
        if (!uuid) {
          throw new TaskActionError(
            "invalid_transition",
            "The first task command is still being accepted",
          );
        }
        const stored = await client.query<ReceiptRow>(
          `SELECT ${receiptColumns} FROM task_action_receipts WHERE id=$1`,
          [uuid],
        );
        if (!stored.rows[0]) throw new Error("Task action receipt is missing");
        await client.query("COMMIT");
        return mapReceipt(stored.rows[0]);
      }

      const lockedTask = await client.query<{ payload: GlobalTask }>(
        `SELECT payload
           FROM workbench_tasks
          WHERE scope_id=$1 AND organization_id=$2 AND project_id=$3 AND task_id=$4
          FOR UPDATE`,
        [
          this.scopeId,
          input.scopedTask.organizationId,
          input.scopedTask.projectId,
          input.scopedTask.task.id,
        ],
      );
      const task = lockedTask.rows[0]?.payload;
      if (!task) throw new TaskActionError("not_found", "Task was not found");
      const concurrentReplay = await client.query<IdempotencyRow>(
        `SELECT request_hash,status,response_ref
           FROM idempotency_records
          WHERE organization_id=$1 AND actor_id=$2 AND endpoint=$3 AND key=$4
          FOR UPDATE`,
        [
          input.scopedTask.organizationId,
          input.actorId,
          endpoint,
          input.idempotencyKey,
        ],
      );
      if (concurrentReplay.rows[0]) {
        if (concurrentReplay.rows[0].request_hash !== input.requestHash) {
          throw new TaskActionError(
            "idempotency_conflict",
            "Idempotency key is already used by another task command",
          );
        }
        const uuid = concurrentReplay.rows[0].response_ref
          ? receiptUuid(concurrentReplay.rows[0].response_ref)
          : null;
        if (!uuid) {
          throw new TaskActionError(
            "invalid_transition",
            "The first task command is still being accepted",
          );
        }
        const stored = await client.query<ReceiptRow>(
          `SELECT ${receiptColumns} FROM task_action_receipts WHERE id=$1`,
          [uuid],
        );
        if (!stored.rows[0]) throw new Error("Task action receipt is missing");
        await client.query("COMMIT");
        return mapReceipt(stored.rows[0]);
      }
      if (task.version !== input.request.expectedVersion) {
        throw new TaskActionError("version_conflict", "Task version changed");
      }
      if (task.action.id !== input.request.action || !task.action.available) {
        throw new TaskActionError(
          "invalid_transition",
          "Action is not available for the current task state",
        );
      }
      const claimedVersion = await client.query<{ id: string }>(
        `SELECT id
           FROM task_action_receipts
          WHERE organization_id=$1 AND project_id=$2 AND task_id=$3
            AND task_version=$4 AND status <> 'failed'
          LIMIT 1`,
        [
          input.scopedTask.organizationId,
          input.scopedTask.projectId,
          task.id,
          task.version,
        ],
      );
      if (claimedVersion.rows[0]) {
        throw new TaskActionError(
          "version_conflict",
          "Another command already owns this task version",
        );
      }
      const reason = input.request.reason?.trim() || "Requested from the workbench";
      const inserted = await client.query<ReceiptRow>(
        `INSERT INTO task_action_receipts
          (id,organization_id,project_id,task_id,goal_id,actor_id,
           idempotency_key,request_hash,request_id,action,reason,input,status,
           task_version,version,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
                 'accepted',$13,1,$14,$14)
         RETURNING ${receiptColumns}`,
        [
          input.receiptUuid,
          input.scopedTask.organizationId,
          input.scopedTask.projectId,
          task.id,
          task.goalId,
          input.actorId,
          input.idempotencyKey,
          input.requestHash,
          input.requestId,
          input.request.action,
          reason,
          JSON.stringify(input.request.input ?? {}),
          task.version,
          new Date(input.submittedAt),
        ],
      );
      const receipt = mapReceipt(inserted.rows[0]);
      const responseDigest = await sha256(receipt);
      const expiresAt = new Date(Date.parse(input.submittedAt) + 24 * 60 * 60 * 1_000);
      await client.query(
        `INSERT INTO idempotency_records
          (organization_id,actor_id,endpoint,key,request_hash,status,
           response_status,response_ref,response_digest,expires_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'completed',202,$6,$7,$8,$9,$9)`,
        [
          input.scopedTask.organizationId,
          input.actorId,
          endpoint,
          input.idempotencyKey,
          input.requestHash,
          receipt.receiptId,
          responseDigest,
          expiresAt,
          new Date(input.submittedAt),
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id,organization_id,project_id,actor_id,action,entity_type,entity_id,
           entity_version,reason,request_id,policy_revision,details_ref,
           details_digest,retention_until,created_at)
         VALUES ($1,$2,$3,$4,$5,'task_action_receipt',$6,$7,$8,$9,
                 'workbench-task-actions.v1',$10,$11,$12,$13)`,
        [
          randomUUID(),
          input.scopedTask.organizationId,
          input.scopedTask.projectId,
          input.actorId,
          `task.${input.request.action}.requested`,
          input.receiptUuid,
          task.version,
          reason,
          input.requestId,
          `db://task_action_receipts/${input.receiptUuid}`,
          input.requestHash,
          new Date(Date.parse(input.submittedAt) + 365 * 24 * 60 * 60 * 1_000),
          new Date(input.submittedAt),
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
          (id,organization_id,aggregate_type,aggregate_id,aggregate_version,
           event_type,deduplication_key,payload,created_at,updated_at)
         VALUES ($1,$2,'task_action_receipt',$3,1,
                 'workbench.task_action.requested',$4,$5::jsonb,$6,$6)`,
        [
          randomUUID(),
          input.scopedTask.organizationId,
          input.receiptUuid,
          `task-action:${input.receiptUuid}:1`,
          JSON.stringify({
            receiptId: receipt.receiptId,
            organizationId: input.scopedTask.organizationId,
            projectId: input.scopedTask.projectId,
            taskId: task.id,
            taskVersion: task.version,
            actorId: input.actorId,
            action: input.request.action,
            reason,
            input: input.request.input ?? {},
            requestId: input.requestId,
            before: { taskVersion: task.version, actionAvailable: true },
            after: { receiptStatus: "accepted", receiptVersion: 1 },
          }),
          new Date(input.submittedAt),
        ],
      );
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") {
        const replay = await this.findIdempotent({
          organizationId: input.scopedTask.organizationId,
          actorId: input.actorId,
          endpoint,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        });
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getReceipt(
    receiptIdValue: string,
    visibility: ActorVisibilityScope,
  ): Promise<CommandReceipt | null> {
    const uuid = receiptUuid(receiptIdValue);
    if (!uuid) return null;
    const result = await this.pool.query<ReceiptRow>(
      `SELECT ${receiptColumns}
         FROM task_action_receipts
        WHERE id=$1
          AND (
            organization_id=ANY($2::uuid[])
            OR project_id=ANY($3::uuid[])
          )`,
      [uuid, [...visibility.organizationIds], [...visibility.projectIds]],
    );
    return result.rows[0] ? mapReceipt(result.rows[0]) : null;
  }

  async transitionReceipt(input: TransitionTaskReceiptInput): Promise<CommandReceipt> {
    const uuid = receiptUuid(input.receiptId);
    if (!uuid) throw new TaskActionError("not_found", "Receipt was not found");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<ReceiptRow>(
        `SELECT ${receiptColumns}
           FROM task_action_receipts
          WHERE id=$1 FOR UPDATE`,
        [uuid],
      );
      const current = currentResult.rows[0];
      if (!current) throw new TaskActionError("not_found", "Receipt was not found");
      if (["completed", "failed"].includes(current.status)) {
        throw new TaskActionError("invalid_transition", "Receipt is already terminal");
      }
      const allowed = current.status === "accepted" ||
        (current.status === "running" && ["completed", "failed"].includes(input.status));
      if (!allowed || input.status === "running" && current.status !== "accepted") {
        throw new TaskActionError("invalid_transition", "Receipt transition is not allowed");
      }
      const terminal = ["completed", "failed"].includes(input.status);
      const updated = await client.query<ReceiptRow>(
        `UPDATE task_action_receipts
            SET status=$2,
                result_task_version=COALESCE($3,result_task_version),
                error=$4::jsonb,
                completed_at=CASE WHEN $5::boolean THEN $6::timestamptz ELSE NULL::timestamptz END,
                version=version+1,
                updated_at=$6::timestamptz
          WHERE id=$1
          RETURNING ${receiptColumns}`,
        [
          uuid,
          input.status,
          input.taskVersion ?? null,
          input.status === "failed" ? JSON.stringify(input.error ?? { code: "command_failed" }) : null,
          terminal,
          new Date(input.occurredAt),
        ],
      );
      const receipt = mapReceipt(updated.rows[0]);
      await client.query(
        `INSERT INTO outbox_events
          (id,organization_id,aggregate_type,aggregate_id,aggregate_version,
           event_type,deduplication_key,payload,created_at,updated_at)
         VALUES ($1,$2,'task_action_receipt',$3,$4,'workbench.receipt.updated',
                 $5,$6::jsonb,$7,$7)`,
        [
          randomUUID(),
          updated.rows[0].organization_id,
          uuid,
          updated.rows[0].version,
          `task-action:${uuid}:${updated.rows[0].version}`,
          JSON.stringify({ receipt }),
          new Date(input.occurredAt),
        ],
      );
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
