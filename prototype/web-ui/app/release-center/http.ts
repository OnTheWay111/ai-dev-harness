import { AuthorizationDeniedError } from "../auth/rbac-policy.ts";
import {
  assertSameOrigin,
  defaultWriteRateLimiter,
  readJsonBody,
  RequestSecurityError,
  type RateLimiter,
  withSecurityHeaders,
} from "../security/request-security.ts";
import {
  ReleaseCenterValidationError,
  type NewCanaryEvent,
  type ProductionGateId,
  type ReleaseSignatureRole,
  type CanaryWindow,
} from "./domain.ts";
import {
  ReleaseCenterIdempotencyConflictError,
  ReleaseCenterNotFoundError,
  ReleaseCenterVersionConflictError,
} from "./repository.ts";
import type { ReleaseCenterService } from "./service.ts";

class AuthenticationRequiredError extends Error {}
class ReleaseRequestError extends Error {}

type HttpService = Partial<Pick<ReleaseCenterService,
  | "snapshot"
  | "createCanary"
  | "approveCanary"
  | "restartCanary"
  | "recordCanaryWindow"
  | "recordCanaryEvent"
  | "resolveCanaryAlert"
  | "finalizeCanary"
  | "createProductionRelease"
  | "recordProductionGate"
  | "evaluateProductionRelease"
  | "signProductionRelease"
>>;

function failure(
  code: string,
  status: number,
  requestId = "request-unavailable",
  detail?: string,
) {
  return withSecurityHeaders(Response.json({
    error: {
      code,
      message: detail
        ? `发布中心操作未完成：${detail}`
        : "发布中心操作未完成",
      impact: "Canary、发布证据和已有签署均未被本次请求覆盖",
      preservedState: "最后一次成功提交的发布状态保持不变",
      nextAction: status === 409 ? "刷新发布状态并重新确认" : "检查输入与角色后重试",
    },
    requestId,
  }, {
    status,
    headers: { "cache-control": "private, no-store" },
  }));
}

function mapError(error: unknown, requestId?: string): Response {
  if (error instanceof AuthenticationRequiredError) {
    return failure("authentication_required", 401, requestId);
  }
  if (error instanceof AuthorizationDeniedError) {
    return failure("forbidden", 403, requestId);
  }
  if (error instanceof RequestSecurityError) {
    return failure(error.code, error.status, requestId);
  }
  if (error instanceof ReleaseCenterNotFoundError) {
    return failure("not_found", 404, requestId);
  }
  if (error instanceof ReleaseCenterVersionConflictError) {
    return failure("version_conflict", 409, requestId);
  }
  if (error instanceof ReleaseCenterIdempotencyConflictError) {
    return failure("idempotency_conflict", 409, requestId);
  }
  if (error instanceof ReleaseCenterValidationError ||
    error instanceof ReleaseRequestError) {
    return failure("validation_failed", 400, requestId, error.message);
  }
  if (error instanceof TypeError) {
    return failure("validation_failed", 400, requestId);
  }
  return failure("internal_error", 500, requestId);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseRequestError("object body required");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new ReleaseRequestError("unknown body field");
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ReleaseRequestError(`${label} is invalid`);
  }
  return value;
}

function text(value: unknown, label: string, minimum = 1): string {
  if (typeof value !== "string" || value.trim().length < minimum ||
    value.trim().length > 4_000) {
    throw new ReleaseRequestError(`${label} is required and bounded`);
  }
  return value.trim();
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ReleaseRequestError(`${label} must be a positive integer`);
  }
  return value as number;
}

function list(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 ||
    value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ReleaseRequestError(`${label} must be a non-empty bounded list`);
  }
  return value.map((item) => String(item).trim());
}

function scope(value: Record<string, unknown>) {
  return {
    organizationId: uuid(value.organizationId, "organizationId"),
    projectId: uuid(value.projectId, "projectId"),
  };
}

function queryScope(request: Request) {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) =>
    !["organizationId", "projectId"].includes(key)
  )) throw new ReleaseRequestError("unknown query field");
  return {
    organizationId: uuid(url.searchParams.get("organizationId"), "organizationId"),
    projectId: uuid(url.searchParams.get("projectId"), "projectId"),
  };
}

function header(request: Request, name: string, minimum = 1): string {
  return text(request.headers.get(name), name, minimum);
}

function response(data: unknown, status = 200): Response {
  return withSecurityHeaders(Response.json({ data }, {
    status,
    headers: { "cache-control": "private, no-store" },
  }));
}

export function createReleaseCenterHandlers(input: {
  service: HttpService;
  actorResolver(request: Request): Promise<{ actorId: string } | null>;
  allowedOrigins?: readonly string[];
  rateLimiter?: RateLimiter;
}) {
  const actor = async (request: Request) => {
    const resolved = await input.actorResolver(request);
    if (!resolved) throw new AuthenticationRequiredError();
    return resolved.actorId;
  };
  const write = async (request: Request) => {
    assertSameOrigin(request, input.allowedOrigins);
    const actorId = await actor(request);
    const body = record(await readJsonBody(request, 256 * 1024));
    const command = {
      ...scope(body),
      actorId,
      requestId: header(request, "x-request-id"),
      idempotencyKey: header(request, "idempotency-key", 8),
      reason: text(body.reason, "reason", 20),
    };
    (input.rateLimiter ?? defaultWriteRateLimiter).consume({
      actorId,
      organizationId: command.organizationId,
      endpoint: new URL(request.url).pathname,
    });
    return { body, command };
  };

  return {
    collection: async (request: Request): Promise<Response> => {
      try {
        if (request.method !== "GET") return failure("not_found", 404);
        const actorId = await actor(request);
        const service = input.service.snapshot;
        if (!service) throw new Error("snapshot service unavailable");
        return response(await service.call(input.service, {
          ...queryScope(request), actorId,
        }));
      } catch (error) {
        return mapError(error, request.headers.get("x-request-id") ?? undefined);
      }
    },

    canaryCollection: async (request: Request): Promise<Response> => {
      try {
        if (request.method !== "POST") return failure("not_found", 404);
        const { body, command } = await write(request);
        exact(body, [
          "organizationId", "projectId", "goalId", "candidateCommit",
          "goalContractVersion", "allowedAreas", "excludedAreas",
          "successConditions", "stopConditions", "rollbackRunbook",
          "stopRunbook", "reason",
        ]);
        const service = input.service.createCanary;
        if (!service) throw new Error("create Canary service unavailable");
        return response(await service.call(input.service, {
          ...command,
          goalId: uuid(body.goalId, "goalId"),
          candidateCommit: text(body.candidateCommit, "candidateCommit"),
          goalContractVersion: integer(body.goalContractVersion, "goalContractVersion"),
          allowedAreas: list(body.allowedAreas, "allowedAreas"),
          excludedAreas: list(body.excludedAreas, "excludedAreas"),
          successConditions: list(body.successConditions, "successConditions"),
          stopConditions: list(body.stopConditions, "stopConditions"),
          rollbackRunbook: text(body.rollbackRunbook, "rollbackRunbook"),
          stopRunbook: text(body.stopRunbook, "stopRunbook"),
        }), 201);
      } catch (error) {
        return mapError(error, request.headers.get("x-request-id") ?? undefined);
      }
    },

    canaryAction: async (request: Request, canaryId: string): Promise<Response> => {
      try {
        if (request.method !== "POST") return failure("not_found", 404);
        const resolvedCanaryId = uuid(canaryId, "canaryId");
        const { body, command } = await write(request);
        const type = text(body.type, "type");
        const common = {
          ...command,
          canaryId: resolvedCanaryId,
          expectedVersion: integer(body.expectedVersion, "expectedVersion"),
        };
        if (type === "approve" || type === "restart" || type === "finalize") {
          exact(body, ["organizationId", "projectId", "type", "expectedVersion", "reason"]);
          const service = type === "approve" ? input.service.approveCanary
            : type === "restart" ? input.service.restartCanary
            : input.service.finalizeCanary;
          if (!service) throw new Error(`${type} Canary service unavailable`);
          return response(await service.call(input.service, common));
        }
        if (type === "record-window") {
          exact(body, [
            "organizationId", "projectId", "type", "expectedVersion",
            "reason", "window",
          ]);
          const service = input.service.recordCanaryWindow;
          if (!service) throw new Error("record window service unavailable");
          const window = record(body.window);
          exact(window, [
            "sequence", "startedAt", "endedAt", "status", "p0Count",
            "p1Count", "evidenceRefs",
          ]);
          return response(await service.call(input.service, {
            ...common,
            window: window as unknown as Omit<
              CanaryWindow, "attempt" | "recordedBy"
            >,
          }));
        }
        if (type === "record-event") {
          exact(body, [
            "organizationId", "projectId", "type", "expectedVersion",
            "reason", "event",
          ]);
          const service = input.service.recordCanaryEvent;
          if (!service) throw new Error("record event service unavailable");
          const event = record(body.event);
          const eventKind = text(event.kind, "event.kind");
          const eventFields = eventKind === "intervention"
            ? ["id", "kind", "observedAt", "ownerId", "reason", "evidenceRefs"]
            : eventKind === "alert"
              ? ["id", "kind", "severity", "observedAt", "ownerId", "resolved", "evidenceRefs"]
              : eventKind === "defect"
                ? ["id", "kind", "severity", "observedAt", "ownerId", "workaround", "status", "evidenceRefs"]
                : [];
          if (eventFields.length === 0) throw new ReleaseRequestError("unknown Canary event kind");
          exact(event, eventFields);
          return response(await service.call(input.service, {
            ...common,
            event: event as unknown as NewCanaryEvent,
          }));
        }
        if (type === "resolve-alert") {
          exact(body, [
            "organizationId", "projectId", "type", "expectedVersion",
            "reason", "eventId",
          ]);
          const service = input.service.resolveCanaryAlert;
          if (!service) throw new Error("resolve alert service unavailable");
          return response(await service.call(input.service, {
            ...common, eventId: text(body.eventId, "eventId"),
          }));
        }
        throw new ReleaseRequestError("unknown Canary action");
      } catch (error) {
        return mapError(error, request.headers.get("x-request-id") ?? undefined);
      }
    },

    productionCollection: async (request: Request): Promise<Response> => {
      try {
        if (request.method !== "POST") return failure("not_found", 404);
        const { body, command } = await write(request);
        exact(body, ["organizationId", "projectId", "canaryId", "reason"]);
        const service = input.service.createProductionRelease;
        if (!service) throw new Error("create Production release service unavailable");
        return response(await service.call(input.service, {
          ...command, canaryId: uuid(body.canaryId, "canaryId"),
        }), 201);
      } catch (error) {
        return mapError(error, request.headers.get("x-request-id") ?? undefined);
      }
    },

    productionAction: async (request: Request, releaseId: string): Promise<Response> => {
      try {
        if (request.method !== "POST") return failure("not_found", 404);
        const resolvedReleaseId = uuid(releaseId, "releaseId");
        const { body, command } = await write(request);
        const type = text(body.type, "type");
        const common = {
          ...command,
          releaseId: resolvedReleaseId,
          expectedVersion: integer(body.expectedVersion, "expectedVersion"),
        };
        if (type === "evaluate") {
          exact(body, ["organizationId", "projectId", "type", "expectedVersion", "reason"]);
          const service = input.service.evaluateProductionRelease;
          if (!service) throw new Error("evaluate release service unavailable");
          return response(await service.call(input.service, common));
        }
        if (type === "check-gate") {
          exact(body, [
            "organizationId", "projectId", "type", "expectedVersion",
            "reason", "gateId", "ownerRole", "evidenceRefs",
          ]);
          const service = input.service.recordProductionGate;
          if (!service) throw new Error("gate service unavailable");
          return response(await service.call(input.service, {
            ...common,
            gateId: text(body.gateId, "gateId") as ProductionGateId,
            ownerRole: text(body.ownerRole, "ownerRole") as ReleaseSignatureRole,
            evidenceRefs: list(body.evidenceRefs, "evidenceRefs"),
          }));
        }
        if (type === "sign") {
          exact(body, [
            "organizationId", "projectId", "type", "expectedVersion",
            "reason", "role",
          ]);
          const service = input.service.signProductionRelease;
          if (!service) throw new Error("signature service unavailable");
          return response(await service.call(input.service, {
            ...common,
            role: text(body.role, "role") as ReleaseSignatureRole,
          }));
        }
        throw new ReleaseRequestError("unknown Production action");
      } catch (error) {
        return mapError(error, request.headers.get("x-request-id") ?? undefined);
      }
    },
  };
}
