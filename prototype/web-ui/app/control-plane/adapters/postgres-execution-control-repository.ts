import { randomUUID } from "node:crypto";

import type { PostgresPool } from "./postgres-goal-repository.ts";
import type {
  ExecutionControlReceipt,
  ExecutionControlRecord,
  ExecutionControlRepository,
} from "../ports/execution-control-port.ts";

interface ControlRow {
  id: string;
  organization_id: string | null;
  project_id: string | null;
  scope_type: "global" | "project";
  scope_key: string;
  state: ExecutionControlRecord["state"];
  consecutive_failures: number;
  circuit_open_until: Date | null;
  reason: string;
  version: number;
}

interface ReceiptRow {
  request_hash: string;
  receipt: ExecutionControlReceipt;
}

function mapControl(row: ControlRow): ExecutionControlRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    scopeType: row.scope_type,
    scopeId: row.scope_key,
    state: row.state,
    consecutiveFailures: row.consecutive_failures,
    circuitOpenUntil: row.circuit_open_until?.toISOString() ?? null,
    reason: row.reason,
    version: row.version,
  };
}

export class PostgresExecutionControlRepository implements ExecutionControlRepository {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async findReceipt(input: {
    actorId: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<ExecutionControlReceipt | null> {
    const result = await this.pool.query<ReceiptRow>(
      `SELECT request_hash,receipt
         FROM execution_command_receipts
        WHERE actor_id=$1 AND idempotency_key=$2`,
      [input.actorId, input.idempotencyKey],
    );
    if (!result.rows[0]) return null;
    if (result.rows[0].request_hash !== input.requestHash) {
      throw new Error("Idempotency key conflicts with another execution command");
    }
    return structuredClone(result.rows[0].receipt);
  }

  async get(
    scopeType: "global" | "project",
    scopeId: string,
  ): Promise<ExecutionControlRecord> {
    if (scopeType === "global" && scopeId !== "global") {
      throw new Error("Global execution control uses the global scope id");
    }
    if (scopeType === "global") {
      const result = await this.pool.query<ControlRow>(
        `INSERT INTO execution_controls
          (scope_type,scope_key,state,reason)
         VALUES ('global','global','active','Execution enabled by default')
         ON CONFLICT (scope_type,scope_key) DO UPDATE SET scope_key=EXCLUDED.scope_key
         RETURNING id,organization_id,project_id,scope_type,scope_key,state,
                   consecutive_failures,circuit_open_until,reason,version`,
        [],
      );
      return mapControl(result.rows[0]);
    }
    const result = await this.pool.query<ControlRow>(
      `INSERT INTO execution_controls
        (organization_id,project_id,scope_type,scope_key,state,reason)
       SELECT organization_id,id,'project',id::text,'active','Execution enabled by default'
         FROM projects WHERE id=$1
       ON CONFLICT (scope_type,scope_key) DO UPDATE SET scope_key=EXCLUDED.scope_key
       RETURNING id,organization_id,project_id,scope_type,scope_key,state,
                 consecutive_failures,circuit_open_until,reason,version`,
      [scopeId],
    );
    if (!result.rows[0]) throw new Error("Execution control project was not found");
    return mapControl(result.rows[0]);
  }

  async commit(input: {
    current: ExecutionControlRecord;
    expectedVersion: number;
    nextState: ExecutionControlRecord["state"];
    operation: ExecutionControlReceipt["operation"];
    actorId: string;
    requestId: string;
    idempotencyKey: string;
    requestHash: string;
    reason: string;
    occurredAt: string;
  }): Promise<ExecutionControlReceipt> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await client.query<ReceiptRow>(
        `SELECT request_hash,receipt FROM execution_command_receipts
          WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.actorId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== input.requestHash) {
          throw new Error("Idempotency key conflicts with another execution command");
        }
        await client.query("COMMIT");
        return structuredClone(replay.rows[0].receipt);
      }
      const updated = await client.query<ControlRow>(
        `UPDATE execution_controls
            SET state=$1,reason=$2,
                consecutive_failures=CASE WHEN $3 IN ('start','retry') THEN 0 ELSE consecutive_failures END,
                circuit_open_until=CASE WHEN $3 IN ('start','retry') THEN NULL ELSE circuit_open_until END,
                version=version+1,updated_at=GREATEST($4,created_at)
          WHERE id=$5 AND version=$6
        RETURNING id,organization_id,project_id,scope_type,scope_key,state,
                  consecutive_failures,circuit_open_until,reason,version`,
        [
          input.nextState, input.reason, input.operation, new Date(input.occurredAt),
          input.current.id, input.expectedVersion,
        ],
      );
      const control = updated.rows[0];
      if (!control) throw new Error("Execution control version conflict");
      const receipt: ExecutionControlReceipt = {
        scopeType: control.scope_type,
        scopeId: control.scope_key,
        operation: input.operation,
        previousState: input.current.state,
        state: control.state,
        previousVersion: input.expectedVersion,
        version: control.version,
        occurredAt: input.occurredAt,
      };
      await client.query(
        `INSERT INTO execution_command_receipts
          (actor_id,idempotency_key,request_hash,request_id,reason,scope_type,
           scope_key,operation,receipt,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [
          input.actorId, input.idempotencyKey, input.requestHash, input.requestId,
          input.reason, control.scope_type, control.scope_key, input.operation,
          JSON.stringify(receipt), new Date(input.occurredAt),
        ],
      );
      const organizations = control.organization_id
        ? [{ id: control.organization_id }]
        : (await client.query<{ id: string }>("SELECT id FROM organizations")).rows;
      for (const organization of organizations) {
        const eventId = randomUUID();
        await client.query(
          `INSERT INTO outbox_events
            (id,organization_id,aggregate_type,aggregate_id,aggregate_version,
             event_type,deduplication_key,payload)
           VALUES ($1,$2,'execution_control',$3,$4,'execution.control_changed',$5,$6::jsonb)`,
          [
            eventId, organization.id, control.id, control.version,
            `execution-control:${control.id}:${control.version}`,
            JSON.stringify({
              actorId: input.actorId,
              requestId: input.requestId,
              reason: input.reason,
              ...receipt,
            }),
          ],
        );
      }
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") {
        const replay = await this.findReceipt(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
