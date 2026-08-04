import type { ActorVisibilityScope } from "../../auth/visibility-scope.ts";
import type {
  CommandReceipt,
  ExecuteTaskActionRequest,
  GlobalTask,
} from "../contracts.ts";

export type TaskActionErrorCode =
  | "validation_failed"
  | "forbidden"
  | "not_found"
  | "version_conflict"
  | "idempotency_conflict"
  | "invalid_transition";

export class TaskActionError extends Error {
  readonly code: TaskActionErrorCode;

  constructor(code: TaskActionErrorCode, message: string) {
    super(message);
    this.name = "TaskActionError";
    this.code = code;
  }
}

export interface ScopedWorkbenchTask {
  organizationId: string;
  projectId: string;
  task: GlobalTask;
}

export interface AcceptTaskActionInput {
  scopedTask: ScopedWorkbenchTask;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  requestHash: string;
  request: ExecuteTaskActionRequest;
  receiptUuid: string;
  submittedAt: string;
}

export interface TransitionTaskReceiptInput {
  receiptId: string;
  status: Exclude<CommandReceipt["status"], "accepted">;
  occurredAt: string;
  taskVersion?: number;
  error?: CommandReceipt["error"];
}

export interface TaskActionRepository {
  findTask(
    taskId: string,
    visibility: ActorVisibilityScope,
  ): Promise<ScopedWorkbenchTask | null>;
  findIdempotent(input: {
    organizationId: string;
    actorId: string;
    endpoint: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<CommandReceipt | null>;
  accept(input: AcceptTaskActionInput): Promise<CommandReceipt>;
  getReceipt(
    receiptId: string,
    visibility: ActorVisibilityScope,
  ): Promise<CommandReceipt | null>;
  transitionReceipt(input: TransitionTaskReceiptInput): Promise<CommandReceipt>;
}

function visible(
  task: Pick<ScopedWorkbenchTask, "organizationId" | "projectId">,
  visibility: ActorVisibilityScope,
): boolean {
  return visibility.organizationIds.includes(task.organizationId) ||
    visibility.projectIds.includes(task.projectId);
}

function receiptId(uuid: string): string {
  return `rcpt_${uuid}`;
}

function idempotencyScope(input: {
  organizationId: string;
  actorId: string;
  endpoint: string;
  idempotencyKey: string;
}): string {
  return [
    input.organizationId,
    input.actorId,
    input.endpoint,
    input.idempotencyKey,
  ].join("\0");
}

export class MemoryTaskActionRepository implements TaskActionRepository {
  private readonly tasks: ScopedWorkbenchTask[];
  private readonly receipts = new Map<string, {
    receipt: CommandReceipt;
    organizationId: string;
    projectId: string;
  }>();
  private readonly idempotency = new Map<string, {
    requestHash: string;
    receiptId: string;
  }>();

  constructor(tasks: readonly ScopedWorkbenchTask[]) {
    this.tasks = structuredClone([...tasks]);
  }

  receiptCount(): number {
    return this.receipts.size;
  }

  async findTask(
    taskId: string,
    visibility: ActorVisibilityScope,
  ): Promise<ScopedWorkbenchTask | null> {
    const matches = this.tasks.filter((entry) =>
      entry.task.id === taskId && visible(entry, visibility)
    );
    if (matches.length > 1) {
      throw new TaskActionError(
        "validation_failed",
        "Task ID is ambiguous in the visible scope",
      );
    }
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  async findIdempotent(input: {
    organizationId: string;
    actorId: string;
    endpoint: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<CommandReceipt | null> {
    const stored = this.idempotency.get(idempotencyScope(input));
    if (!stored) return null;
    if (stored.requestHash !== input.requestHash) {
      throw new TaskActionError(
        "idempotency_conflict",
        "Idempotency key is already used by another task command",
      );
    }
    return structuredClone(this.receipts.get(stored.receiptId)!.receipt);
  }

  async accept(input: AcceptTaskActionInput): Promise<CommandReceipt> {
    const endpoint = `/api/v1/tasks/${input.scopedTask.task.id}/actions`;
    const replay = await this.findIdempotent({
      organizationId: input.scopedTask.organizationId,
      actorId: input.actorId,
      endpoint,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
    });
    if (replay) return replay;
    if (input.scopedTask.task.version !== input.request.expectedVersion) {
      throw new TaskActionError("version_conflict", "Task version changed");
    }
    const activeAtVersion = [...this.receipts.values()].some((stored) =>
      stored.organizationId === input.scopedTask.organizationId &&
      stored.projectId === input.scopedTask.projectId &&
      stored.receipt.taskId === input.scopedTask.task.id &&
      stored.receipt.taskVersion === input.request.expectedVersion &&
      stored.receipt.status !== "failed"
    );
    if (activeAtVersion) {
      throw new TaskActionError(
        "version_conflict",
        "Another command already owns this task version",
      );
    }
    const exposedId = receiptId(input.receiptUuid);
    const receipt: CommandReceipt = {
      receiptId: exposedId,
      requestId: input.requestId,
      status: "accepted",
      taskId: input.scopedTask.task.id,
      taskVersion: input.scopedTask.task.version,
      submittedAt: input.submittedAt,
      statusUrl: `/api/v1/receipts/${exposedId}`,
    };
    this.receipts.set(exposedId, {
      receipt: structuredClone(receipt),
      organizationId: input.scopedTask.organizationId,
      projectId: input.scopedTask.projectId,
    });
    this.idempotency.set(idempotencyScope({
      organizationId: input.scopedTask.organizationId,
      actorId: input.actorId,
      endpoint,
      idempotencyKey: input.idempotencyKey,
    }), { requestHash: input.requestHash, receiptId: exposedId });
    return structuredClone(receipt);
  }

  async getReceipt(
    receiptIdValue: string,
    visibility: ActorVisibilityScope,
  ): Promise<CommandReceipt | null> {
    const stored = this.receipts.get(receiptIdValue);
    if (!stored || !visible(stored, visibility)) return null;
    return structuredClone(stored.receipt);
  }

  async transitionReceipt(input: TransitionTaskReceiptInput): Promise<CommandReceipt> {
    const stored = this.receipts.get(input.receiptId);
    if (!stored) throw new TaskActionError("not_found", "Receipt was not found");
    if (["completed", "failed"].includes(stored.receipt.status)) {
      throw new TaskActionError("invalid_transition", "Receipt is already terminal");
    }
    if (stored.receipt.status === "accepted" && input.status === "completed" ||
      stored.receipt.status === "accepted" && input.status === "failed" ||
      stored.receipt.status === "accepted" && input.status === "running" ||
      stored.receipt.status === "running" && ["completed", "failed"].includes(input.status)) {
      stored.receipt = {
        ...stored.receipt,
        status: input.status,
        taskVersion: input.taskVersion ?? stored.receipt.taskVersion,
        completedAt: ["completed", "failed"].includes(input.status)
          ? input.occurredAt
          : undefined,
        error: input.status === "failed" ? input.error : undefined,
      };
      return structuredClone(stored.receipt);
    }
    throw new TaskActionError("invalid_transition", "Receipt transition is not allowed");
  }
}
