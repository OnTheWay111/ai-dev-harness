export type ExecutionControlState = "active" | "paused" | "draining" | "stopped";
export type ExecutionControlOperation =
  | "start"
  | "pause"
  | "drain"
  | "resume"
  | "retry"
  | "stop";

export interface ExecutionControlRecord {
  id: string;
  organizationId: string | null;
  projectId: string | null;
  scopeType: "global" | "project";
  scopeId: string;
  state: ExecutionControlState;
  consecutiveFailures: number;
  circuitOpenUntil: string | null;
  reason: string;
  version: number;
}

export interface ExecutionControlReceipt {
  scopeType: "global" | "project";
  scopeId: string;
  operation: ExecutionControlOperation;
  previousState: ExecutionControlState;
  state: ExecutionControlState;
  previousVersion: number;
  version: number;
  occurredAt: string;
}

export interface ExecutionControlRepository {
  findReceipt(input: {
    actorId: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<ExecutionControlReceipt | null>;
  get(scopeType: "global" | "project", scopeId: string): Promise<ExecutionControlRecord>;
  commit(input: {
    current: ExecutionControlRecord;
    expectedVersion: number;
    nextState: ExecutionControlState;
    operation: ExecutionControlOperation;
    actorId: string;
    requestId: string;
    idempotencyKey: string;
    requestHash: string;
    reason: string;
    occurredAt: string;
  }): Promise<ExecutionControlReceipt>;
}
