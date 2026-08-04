import type {
  ExecutionControlOperation,
  ExecutionControlReceipt,
  ExecutionControlRepository,
  ExecutionControlState,
} from "../ports/execution-control-port.ts";

export interface ExecutionControlCommand {
  operation: ExecutionControlOperation;
  scopeType: "global" | "project";
  scopeId: string;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  expectedVersion: number;
  reason: string;
}

export interface ExecutionControlAuthorizer {
  authorize(command: Readonly<{
    actorId: string;
    scopeType: "global" | "project";
    scopeId: string;
    operation: ExecutionControlOperation;
  }>): Promise<void>;
}

function nextState(operation: ExecutionControlOperation): ExecutionControlState {
  if (operation === "pause") return "paused";
  if (operation === "drain") return "draining";
  if (operation === "stop") return "stopped";
  return "active";
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hashed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class ExecutionControlService {
  private readonly repository: ExecutionControlRepository;
  private readonly authorizer: ExecutionControlAuthorizer;
  private readonly clock: () => Date;

  constructor(dependencies: {
    repository: ExecutionControlRepository;
    authorizer: ExecutionControlAuthorizer;
    clock?: () => Date;
  }) {
    this.repository = dependencies.repository;
    this.authorizer = dependencies.authorizer;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async execute(command: ExecutionControlCommand): Promise<ExecutionControlReceipt> {
    if (!command.scopeId.trim() || !command.actorId.trim()) {
      throw new Error("Execution command scope and actor are required");
    }
    if (!command.reason.trim() || command.reason.length > 4000) {
      throw new Error("Execution command reason is required and bounded");
    }
    if (!command.idempotencyKey.trim() || command.idempotencyKey.length > 200) {
      throw new Error("Execution command idempotency key is required");
    }
    await this.authorizer.authorize({
      actorId: command.actorId,
      scopeType: command.scopeType,
      scopeId: command.scopeId,
      operation: command.operation,
    });
    const requestHash = await digest({
      operation: command.operation,
      scopeType: command.scopeType,
      scopeId: command.scopeId,
      actorId: command.actorId,
      expectedVersion: command.expectedVersion,
      reason: command.reason,
    });
    const replay = await this.repository.findReceipt({
      actorId: command.actorId,
      idempotencyKey: command.idempotencyKey,
      requestHash,
    });
    if (replay) return replay;
    const current = await this.repository.get(command.scopeType, command.scopeId);
    if (current.version !== command.expectedVersion) {
      throw new Error("Execution control version conflict");
    }
    return await this.repository.commit({
      current,
      expectedVersion: command.expectedVersion,
      nextState: nextState(command.operation),
      operation: command.operation,
      actorId: command.actorId,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      requestHash,
      reason: command.reason,
      occurredAt: this.clock().toISOString(),
    });
  }
}

export interface DispatchPolicyInput {
  globalState: ExecutionControlState;
  projectState: ExecutionControlState;
  circuitOpen: boolean;
  budgetAvailable: boolean;
  activePhase?: string;
}

export interface DispatchDecision {
  allowed: boolean;
  reason: string;
  cancelActive?: boolean;
}

export function evaluateDispatchDecision(input: DispatchPolicyInput): DispatchDecision {
  let reason = "allowed";
  if (input.globalState === "stopped") reason = "global_stop";
  else if (input.projectState === "stopped") reason = "project_stop";
  else if (input.circuitOpen) reason = "circuit_open";
  else if (!input.budgetAvailable) reason = "budget_exhausted";
  else if (input.globalState === "paused") reason = "global_paused";
  else if (input.projectState === "paused") reason = "project_paused";
  else if (input.globalState === "draining") reason = "global_draining";
  else if (input.projectState === "draining") reason = "project_draining";
  const decision: DispatchDecision = { allowed: reason === "allowed", reason };
  if (input.activePhase !== undefined) {
    const safeCompletion = ["verify", "review", "landing"].includes(input.activePhase);
    decision.cancelActive = reason.endsWith("_stop") && !safeCompletion;
  }
  return decision;
}
