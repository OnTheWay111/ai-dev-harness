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
} from "../../../workbench/server/workbench-repository-factory.ts";

const taskFilters = new Set<TaskFilter>([
  "all",
  "attention",
  "running",
  "review",
  "blocked",
  "waiting",
]);

function requestId(): string {
  return `req_${crypto.randomUUID()}`;
}

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
  return Response.json(body, { status: 400 });
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
  return Response.json(body, { status: 500 });
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

function queryHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
): Promise<Response> {
  const id = requestId();
  const url = new URL(request.url);
  const query = parseQuery(url, id);
  if (query instanceof Response) return query;

  try {
    const workbenchRepository = repositoryProvider();
    const result = await workbenchRepository.getWorkbench(query);
    const etag = `"workbench-${result.data.revision}-${queryHash(url.searchParams.toString())}"`;
    const headers = responseHeaders(etag, workbenchRepository.kind);

    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }

    const body: WorkbenchResponse = { ...result, requestId: id };
    return Response.json(body, { headers });
  } catch (error) {
    if (error instanceof WorkbenchRepositoryError) {
      return validationError(id, error.message, error.field);
    }
    console.error("Failed to load workbench", { requestId: id });
    return internalError(id);
  }
}

export async function GET(request: Request): Promise<Response> {
  return await handleWorkbenchRequest(request);
}
