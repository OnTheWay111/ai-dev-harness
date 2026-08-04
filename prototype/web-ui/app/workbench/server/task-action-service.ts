import type { ActorVisibilityScope } from "../../auth/visibility-scope.ts";
import type {
  CommandReceipt,
  ExecuteTaskActionRequest,
  TaskAction,
} from "../contracts.ts";
import {
  TaskActionError,
  type TaskActionRepository,
} from "./task-action-repository.ts";

export interface TaskActionAuthorizationInput {
  actorId: string;
  organizationId: string;
  projectId: string;
  action: TaskAction["id"];
}

export interface TaskActionAuthorizer {
  authorize(input: TaskActionAuthorizationInput): Promise<void>;
}

const actions = new Set<TaskAction["id"]>([
  "review_evidence",
  "answer_questions",
  "resolve_blocker",
  "inspect_schedule",
  "inspect_run",
]);
const reasonRequired = new Set<TaskAction["id"]>([
  "review_evidence",
  "answer_questions",
  "resolve_blocker",
]);

function validateActionInput(
  action: TaskAction["id"],
  value: Record<string, unknown> | undefined,
): void {
  const input = value ?? {};
  const keys = Object.keys(input);
  if (action === "review_evidence") {
    if (keys.length !== 1 || keys[0] !== "decision" ||
      !["approve", "request_changes", "reject"].includes(String(input.decision))) {
      throw new TaskActionError(
        "validation_failed",
        "Evidence review input requires one valid decision",
      );
    }
    return;
  }
  if (action === "answer_questions") {
    if (keys.length !== 1 || keys[0] !== "source" || input.source !== "workbench") {
      throw new TaskActionError(
        "validation_failed",
        "Question action input requires source=workbench",
      );
    }
    return;
  }
  if (action === "resolve_blocker") {
    if (keys.length === 0 || keys.some((key) => !["source", "resolution"].includes(key)) ||
      input.source !== undefined && input.source !== "workbench" ||
      input.resolution !== undefined &&
        (typeof input.resolution !== "string" ||
          !input.resolution.trim() || input.resolution.length > 4_000)) {
      throw new TaskActionError(
        "validation_failed",
        "Blocker input requires a bounded resolution or source=workbench",
      );
    }
    return;
  }
  if (keys.length > 0) {
    throw new TaskActionError(
      "validation_failed",
      "Inspect actions do not accept input fields",
    );
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

async function digest(value: unknown): Promise<string> {
  const hashed = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return [...new Uint8Array(hashed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseTaskActionRequest(value: unknown): ExecuteTaskActionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskActionError("validation_failed", "Task action body must be an object");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) =>
    !["action", "expectedVersion", "reason", "input"].includes(key)
  )) {
    throw new TaskActionError("validation_failed", "Task action has unknown fields");
  }
  if (!actions.has(body.action as TaskAction["id"]) ||
    !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
    throw new TaskActionError("validation_failed", "Action and expectedVersion are required");
  }
  if (body.reason !== undefined &&
    (typeof body.reason !== "string" || body.reason.trim().length > 4_000)) {
    throw new TaskActionError("validation_failed", "Reason must be a bounded string");
  }
  if (body.input !== undefined &&
    (!body.input || typeof body.input !== "object" || Array.isArray(body.input))) {
    throw new TaskActionError("validation_failed", "Action input must be an object");
  }
  const action = body.action as TaskAction["id"];
  if (reasonRequired.has(action) &&
    (typeof body.reason !== "string" || !body.reason.trim())) {
    throw new TaskActionError("validation_failed", "This action requires a reason");
  }
  validateActionInput(action, body.input as Record<string, unknown> | undefined);
  return {
    action,
    expectedVersion: body.expectedVersion as number,
    reason: typeof body.reason === "string" ? body.reason.trim() : undefined,
    input: body.input as Record<string, unknown> | undefined,
  };
}

export class TaskActionService {
  private readonly repository: TaskActionRepository;
  private readonly authorizer: TaskActionAuthorizer;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(input: {
    repository: TaskActionRepository;
    authorizer: TaskActionAuthorizer;
    clock?: () => Date;
    idFactory?: () => string;
  }) {
    this.repository = input.repository;
    this.authorizer = input.authorizer;
    this.clock = input.clock ?? (() => new Date());
    this.idFactory = input.idFactory ?? (() => crypto.randomUUID());
  }

  async getTask(taskId: string, visibility: ActorVisibilityScope) {
    const scoped = await this.repository.findTask(taskId, visibility);
    if (!scoped) throw new TaskActionError("not_found", "Task was not found");
    return structuredClone(scoped.task);
  }

  async submit(input: {
    taskId: string;
    actorId: string;
    visibility: ActorVisibilityScope;
    requestId: string;
    idempotencyKey: string;
    request: ExecuteTaskActionRequest;
  }): Promise<CommandReceipt> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.taskId)) {
      throw new TaskActionError("validation_failed", "Task ID is invalid");
    }
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
      throw new TaskActionError("validation_failed", "Idempotency-Key is required and bounded");
    }
    const request = parseTaskActionRequest(input.request);
    const scopedTask = await this.repository.findTask(input.taskId, input.visibility);
    if (!scopedTask) throw new TaskActionError("not_found", "Task was not found");
    await this.authorizer.authorize({
      actorId: input.actorId,
      organizationId: scopedTask.organizationId,
      projectId: scopedTask.projectId,
      action: request.action,
    });
    const endpoint = `/api/v1/tasks/${input.taskId}/actions`;
    const requestHash = await digest({
      taskId: input.taskId,
      actorId: input.actorId,
      request,
    });
    const replay = await this.repository.findIdempotent({
      organizationId: scopedTask.organizationId,
      actorId: input.actorId,
      endpoint,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    });
    if (replay) return replay;
    if (scopedTask.task.version !== request.expectedVersion) {
      throw new TaskActionError("version_conflict", "Task version changed");
    }
    if (scopedTask.task.action.id !== request.action ||
      !scopedTask.task.action.available) {
      throw new TaskActionError(
        "invalid_transition",
        "Action is not available for the current task state",
      );
    }
    return await this.repository.accept({
      scopedTask,
      actorId: input.actorId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      request,
      receiptUuid: this.idFactory(),
      submittedAt: this.clock().toISOString(),
    });
  }

  async getReceipt(
    receiptId: string,
    visibility: ActorVisibilityScope,
  ): Promise<CommandReceipt> {
    const receipt = await this.repository.getReceipt(receiptId, visibility);
    if (!receipt) throw new TaskActionError("not_found", "Receipt was not found");
    return receipt;
  }

  async transitionReceipt(
    receiptId: string,
    status: Exclude<CommandReceipt["status"], "accepted">,
    result: {
      taskVersion?: number;
      error?: CommandReceipt["error"];
    } = {},
  ): Promise<CommandReceipt> {
    return await this.repository.transitionReceipt({
      receiptId,
      status,
      occurredAt: this.clock().toISOString(),
      ...result,
    });
  }
}
