import type {
  ApiErrorEnvelope,
  TaskFilter,
  WorkbenchQuery,
  WorkbenchResponse,
} from "../../../workbench/contracts.ts";
import {
  type WorkbenchReadRepository,
  WorkbenchRepositoryError,
} from "../../../workbench/server/workbench-repository.ts";
import {
  getWorkbenchRepository,
  getWorkbenchVisibilityResolver,
} from "../../../workbench/server/workbench-repository-factory.ts";
import {
  hasVisibleProjects,
  visibilityScopeKey,
  type ActorVisibilityScope,
} from "../../../auth/visibility-scope.ts";
import { readRequestPrincipal } from "../../../auth/oidc-http.ts";
import { getOidcService } from "../../../auth/oidc-runtime.ts";
import { withSecurityHeaders } from
  "../../../security/request-security.ts";
import {
  contextFromRequest,
  traceparent,
} from "../../../observability/context.ts";
import {
  getOperationalTelemetry,
  type OperationalTelemetry,
} from "../../../observability/telemetry.ts";

const taskFilters = new Set<TaskFilter>([
  "all",
  "attention",
  "running",
  "review",
  "blocked",
  "waiting",
]);

function validationError(
  requestIdValue: string,
  message: string,
  field?: keyof WorkbenchQuery,
): Response {
  const body: ApiErrorEnvelope = {
    error: {
      code: "validation_failed",
      message,
      impact: "工作台数据未加载",
      preservedState: "当前页面已有数据不会被覆盖",
      nextAction: "修正查询条件后重试",
      fieldErrors: field ? { [field]: [message] } : undefined,
    },
    requestId: requestIdValue,
  };
  return withSecurityHeaders(Response.json(body, { status: 400 }));
}

function internalError(requestIdValue: string): Response {
  const body: ApiErrorEnvelope = {
    error: {
      code: "internal_error",
      message: "工作台数据暂时不可用",
      impact: "本次刷新未完成",
      preservedState: "浏览器会继续保留上一次成功加载的数据",
      nextAction: "稍后重试；如持续失败，请提供请求 ID",
    },
    requestId: requestIdValue,
  };
  return withSecurityHeaders(Response.json(body, { status: 500 }));
}

function accessError(
  requestIdValue: string,
  status: 401 | 403,
): Response {
  const body: ApiErrorEnvelope = {
    error: {
      code: "forbidden",
      message: status === 401 ? "需要有效登录会话" : "当前账号没有可见项目",
      impact: "工作台数据未加载",
      preservedState: "任何组织、项目或 Goal 数据均未返回",
      nextAction: status === 401 ? "重新登录后再试" : "联系组织管理员分配角色",
    },
    requestId: requestIdValue,
  };
  return withSecurityHeaders(Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  }));
}

function parseQuery(url: URL, id: string): WorkbenchQuery | Response {
  const filterValue = url.searchParams.get("filter");
  if (filterValue && !taskFilters.has(filterValue as TaskFilter)) {
    return validationError(id, `不支持的 filter：${filterValue}`, "filter");
  }

  const limitValue = url.searchParams.get("limit");
  if (limitValue && !/^\d+$/.test(limitValue)) {
    return validationError(id, "limit 必须是 1 到 100 的整数", "limit");
  }
  const limit = limitValue ? Number(limitValue) : undefined;
  if (limit !== undefined && (limit < 1 || limit > 100)) {
    return validationError(id, "limit 必须是 1 到 100 的整数", "limit");
  }

  const goalId = url.searchParams.get("goalId")?.trim() || undefined;
  if (goalId && !/^[A-Za-z0-9_-]{1,64}$/.test(goalId)) {
    return validationError(id, "goalId 格式无效", "goalId");
  }
  const cursor = url.searchParams.get("cursor") || undefined;

  return {
    goalId,
    filter: filterValue as TaskFilter | undefined,
    cursor,
    limit,
  };
}

async function responseHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function responseHeaders(etag: string, source: string): HeadersInit {
  return {
    "cache-control": "private, no-cache",
    etag,
    "x-workbench-source": source,
  };
}

export async function handleWorkbenchRequest(
  request: Request,
  repositoryProvider: () => WorkbenchReadRepository = getWorkbenchRepository,
  visibilityProvider: (
    request: Request,
  ) => Promise<ActorVisibilityScope | null> = async (currentRequest) => {
    const principal = await readRequestPrincipal(
      currentRequest,
      getOidcService(),
    );
    return principal
      ? await getWorkbenchVisibilityResolver().resolve(principal.actorId)
      : null;
  },
  telemetry: OperationalTelemetry = getOperationalTelemetry(),
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const suppliedGoalId = url.searchParams.get("goalId")?.trim();
  const observed = contextFromRequest(request,
    suppliedGoalId && /^[A-Za-z0-9_-]{1,64}$/.test(suppliedGoalId)
      ? { goalId: suppliedGoalId }
      : {});
  const id = observed.requestId;
  const observe = (response: Response): Response => {
    response.headers.set("x-request-id", observed.requestId);
    response.headers.set("traceparent", traceparent(observed));
    telemetry.event("web.request.completed", observed, {
      method: "GET",
      route: "/api/v1/workbench",
      status: response.status,
    }, response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info");
    telemetry.metric("harness_http_request_duration_ms", "histogram",
      Date.now() - startedAt, {
        route: "/api/v1/workbench",
        status: String(response.status),
      });
    return response;
  };
  const query = parseQuery(url, id);
  if (query instanceof Response) return observe(query);

  try {
    const visibility = await visibilityProvider(request);
    if (!visibility) return observe(accessError(id, 401));
    if (!hasVisibleProjects(visibility)) return observe(accessError(id, 403));
    const workbenchRepository = repositoryProvider();
    const result = await workbenchRepository.getWorkbench(visibility, query);
    const etag = `"workbench-${await responseHash([
      visibilityScopeKey(visibility),
      result.cacheTag,
      url.searchParams.toString(),
    ].join("|"))}"`;
    const headers = responseHeaders(etag, workbenchRepository.kind);

    if (request.headers.get("if-none-match") === etag) {
      return observe(withSecurityHeaders(new Response(null, { status: 304, headers })));
    }

    const body: WorkbenchResponse = {
      data: result.data,
      page: result.page,
      requestId: id,
    };
    return observe(withSecurityHeaders(Response.json(body, { headers })));
  } catch (error) {
    if (error instanceof WorkbenchRepositoryError) {
      return observe(validationError(id, error.message, error.field));
    }
    telemetry.event("web.request.failed", observed, { error }, "error");
    return observe(internalError(id));
  }
}

export async function GET(request: Request): Promise<Response> {
  return await handleWorkbenchRequest(request);
}
