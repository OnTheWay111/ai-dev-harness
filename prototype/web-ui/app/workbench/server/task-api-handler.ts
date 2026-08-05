import type { ActorVisibilityScope } from "../../auth/visibility-scope.ts";
import { AuthorizationDeniedError } from "../../auth/rbac-policy.ts";
import {
  assertSameOrigin,
  defaultWriteRateLimiter,
  readJsonBody,
  RequestSecurityError,
  type RateLimiter,
  withSecurityHeaders,
} from "../../security/request-security.ts";
import type { ApiErrorEnvelope } from "../contracts.ts";
import { TaskActionError } from "./task-action-repository.ts";
import type { TaskActionService } from "./task-action-service.ts";
import {
  childObservabilityContext,
  contextFromRequest,
  traceparent,
  type ObservabilityContext,
} from "../../observability/context.ts";
import {
  getOperationalTelemetry,
  type OperationalTelemetry,
} from "../../observability/telemetry.ts";

class AuthenticationRequiredError extends Error {}

function statusFor(code: ApiErrorEnvelope["error"]["code"]): number {
  if (code === "validation_failed") return 400;
  if (code === "forbidden") return 403;
  if (code === "not_found") return 404;
  if (["version_conflict", "idempotency_conflict", "invalid_transition"].includes(code)) return 409;
  if (code === "rate_limited") return 429;
  return 500;
}

function errorEnvelope(
  code: ApiErrorEnvelope["error"]["code"],
  id: string,
  message?: string,
): Response {
  const conflict = code === "version_conflict" || code === "idempotency_conflict";
  const forbidden = code === "forbidden";
  const body: ApiErrorEnvelope = {
    error: {
      code,
      message: message ?? "任务操作未完成",
      impact: forbidden
        ? "本次操作未提交，任务状态未改变"
        : conflict
        ? "当前命令未覆盖其他操作者的更新"
        : "本次操作未完成",
      preservedState: "当前任务、上次成功数据和理由草稿均保持不变",
      nextAction: forbidden
        ? "联系管理员分配任务所需角色"
        : conflict
        ? "刷新任务详情后重新确认"
        : "检查输入后重试；如持续失败请提供请求 ID",
    },
    requestId: id,
  };
  return withSecurityHeaders(Response.json(body, {
    status: statusFor(code),
    headers: { "cache-control": "private, no-store" },
  }));
}

function mappedError(error: unknown, id: string): Response {
  if (error instanceof TaskActionError) {
    return errorEnvelope(error.code, id, error.message);
  }
  if (error instanceof AuthenticationRequiredError) {
    return errorEnvelope("forbidden", id, "需要有效登录会话");
  }
  if (error instanceof AuthorizationDeniedError ||
    (error instanceof Error && (error as Error & { code?: string }).code === "forbidden")) {
    return errorEnvelope("forbidden", id, "当前账号无权执行此任务操作");
  }
  if (error instanceof RequestSecurityError) {
    const code = error.code === "rate_limited"
      ? "rate_limited"
      : error.code === "csrf_rejected"
      ? "forbidden"
      : "validation_failed";
    const response = errorEnvelope(code, id, "任务请求未通过安全校验");
    if (error.retryAfterSeconds) {
      response.headers.set("retry-after", String(error.retryAfterSeconds));
    }
    return response;
  }
  return errorEnvelope("internal_error", id, "任务服务暂时不可用");
}

function validResourceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

export function createTaskApiHandlers(input: {
  service: TaskActionService;
  actorResolver(request: Request): Promise<{ actorId: string } | null>;
  visibilityResolver(request: Request): Promise<ActorVisibilityScope>;
  rateLimiter?: RateLimiter;
  allowedOrigins?: readonly string[];
  telemetry?: OperationalTelemetry;
}) {
  const telemetry = input.telemetry ?? getOperationalTelemetry();
  const observe = (
    response: Response,
    observed: ObservabilityContext,
    route: string,
    method: "GET" | "POST",
    startedAt: number,
  ): Response => {
    response.headers.set("x-request-id", observed.requestId);
    response.headers.set("traceparent", traceparent(observed));
    telemetry.event("web.request.completed", observed, {
      method,
      route,
      status: response.status,
    }, response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info");
    telemetry.metric("harness_http_request_duration_ms", "histogram",
      Date.now() - startedAt, { route, status: String(response.status) });
    return response;
  };
  const context = async (request: Request) => {
    const actor = await input.actorResolver(request);
    if (!actor) throw new AuthenticationRequiredError();
    return {
      actor,
      visibility: await input.visibilityResolver(request),
    };
  };
  return {
    task: async (request: Request, taskId: string): Promise<Response> => {
      const startedAt = Date.now();
      const observed = contextFromRequest(request);
      const id = observed.requestId;
      try {
        if (request.method !== "GET" || !validResourceId(taskId)) {
          throw new TaskActionError("not_found", "Task was not found");
        }
        const resolved = await context(request);
        return observe(withSecurityHeaders(Response.json({
          data: await input.service.getTask(taskId, resolved.visibility),
          requestId: id,
        }, { headers: { "cache-control": "private, no-store" } })), observed,
        "/api/v1/tasks/:taskId", "GET", startedAt);
      } catch (error) {
        return observe(mappedError(error, id), observed,
          "/api/v1/tasks/:taskId", "GET", startedAt);
      }
    },
    action: async (request: Request, taskId: string): Promise<Response> => {
      const startedAt = Date.now();
      const observed = contextFromRequest(request);
      const id = observed.requestId;
      try {
        if (request.method !== "POST" || !validResourceId(taskId)) {
          throw new TaskActionError("not_found", "Task was not found");
        }
        assertSameOrigin(request, input.allowedOrigins);
        const resolved = await context(request);
        const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
        const body = await readJsonBody(request, 16 * 1024);
        (input.rateLimiter ?? defaultWriteRateLimiter).consume({
          actorId: resolved.actor.actorId,
          organizationId: resolved.visibility.organizationIds[0] ??
            resolved.visibility.projectIds[0] ?? "unscoped",
          endpoint: "task.action",
        });
        const receipt = await input.service.submit({
          taskId,
          actorId: resolved.actor.actorId,
          visibility: resolved.visibility,
          requestId: id,
          idempotencyKey,
          request: body as never,
        });
        const receiptContext = childObservabilityContext(observed, "web", {
          receiptId: receipt.receiptId,
        });
        telemetry.event("task.action.accepted", receiptContext, {
          taskId,
          status: receipt.status,
        }, "audit");
        return observe(withSecurityHeaders(Response.json(receipt, {
          status: 202,
          headers: { "cache-control": "private, no-store" },
        })), receiptContext, "/api/v1/tasks/:taskId/actions", "POST", startedAt);
      } catch (error) {
        return observe(mappedError(error, id), observed,
          "/api/v1/tasks/:taskId/actions", "POST", startedAt);
      }
    },
    receipt: async (request: Request, receiptId: string): Promise<Response> => {
      const startedAt = Date.now();
      const observed = contextFromRequest(request, { receiptId });
      const id = observed.requestId;
      try {
        if (request.method !== "GET" ||
          !/^rcpt_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receiptId)) {
          throw new TaskActionError("not_found", "Receipt was not found");
        }
        const resolved = await context(request);
        return observe(withSecurityHeaders(Response.json(
          await input.service.getReceipt(receiptId, resolved.visibility),
          { headers: { "cache-control": "private, no-store" } },
        )), observed, "/api/v1/receipts/:receiptId", "GET", startedAt);
      } catch (error) {
        return observe(mappedError(error, id), observed,
          "/api/v1/receipts/:receiptId", "GET", startedAt);
      }
    },
  };
}
