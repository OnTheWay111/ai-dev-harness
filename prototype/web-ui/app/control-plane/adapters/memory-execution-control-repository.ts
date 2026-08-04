import type {
  ExecutionControlReceipt,
  ExecutionControlRecord,
  ExecutionControlRepository,
} from "../ports/execution-control-port.ts";

export class MemoryExecutionControlRepository implements ExecutionControlRepository {
  readonly records: ExecutionControlRecord[] = [];
  readonly receipts = new Map<string, {
    requestHash: string;
    receipt: ExecutionControlReceipt;
  }>();
  readonly auditEvents: Readonly<Record<string, unknown>>[] = [];
  readonly outboxEvents: Readonly<Record<string, unknown>>[] = [];

  async findReceipt(input: {
    actorId: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<ExecutionControlReceipt | null> {
    const stored = this.receipts.get(`${input.actorId}:${input.idempotencyKey}`);
    if (!stored) return null;
    if (stored.requestHash !== input.requestHash) {
      throw new Error("Idempotency key conflicts with another execution command");
    }
    return structuredClone(stored.receipt);
  }

  async get(
    scopeType: "global" | "project",
    scopeId: string,
  ): Promise<ExecutionControlRecord> {
    let record = this.records.find((candidate) =>
      candidate.scopeType === scopeType && candidate.scopeId === scopeId
    );
    if (!record) {
      record = {
        id: crypto.randomUUID(),
        organizationId: null,
        projectId: scopeType === "project" ? scopeId : null,
        scopeType,
        scopeId,
        state: "active",
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        reason: "Execution enabled by default",
        version: 1,
      };
      this.records.push(record);
    }
    return structuredClone(record);
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
    const replay = await this.findReceipt(input);
    if (replay) return replay;
    const record = this.records.find((candidate) =>
      candidate.scopeType === input.current.scopeType &&
      candidate.scopeId === input.current.scopeId
    );
    if (!record || record.version !== input.expectedVersion) {
      throw new Error("Execution control version conflict");
    }
    const receipt: ExecutionControlReceipt = {
      scopeType: record.scopeType,
      scopeId: record.scopeId,
      operation: input.operation,
      previousState: record.state,
      state: input.nextState,
      previousVersion: record.version,
      version: record.version + 1,
      occurredAt: input.occurredAt,
    };
    record.state = input.nextState;
    record.reason = input.reason;
    record.version += 1;
    if (input.operation === "retry" || input.operation === "start") {
      record.consecutiveFailures = 0;
      record.circuitOpenUntil = null;
    }
    this.receipts.set(`${input.actorId}:${input.idempotencyKey}`, {
      requestHash: input.requestHash,
      receipt: structuredClone(receipt),
    });
    this.auditEvents.push({
      action: `execution.${input.operation}`,
      actorId: input.actorId,
      requestId: input.requestId,
      reason: input.reason,
      entityVersion: receipt.version,
    });
    this.outboxEvents.push({
      eventType: "execution.control_changed",
      scopeType: record.scopeType,
      scopeId: record.scopeId,
      state: record.state,
      version: record.version,
    });
    return structuredClone(receipt);
  }
}
