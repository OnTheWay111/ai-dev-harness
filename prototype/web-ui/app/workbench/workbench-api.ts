import type {
  ApiErrorEnvelope,
  CommandReceipt,
  ExecuteTaskActionRequest,
  TaskDetailResponse,
  WorkbenchApi,
  WorkbenchQuery,
  WorkbenchResponse,
} from "./contracts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CachedWorkbenchResponse {
  etag: string;
  body: WorkbenchResponse;
}

export class WorkbenchApiError extends Error {
  readonly status: number;
  readonly envelope: ApiErrorEnvelope;

  constructor(
    status: number,
    envelope: ApiErrorEnvelope,
  ) {
    super(envelope.error.message);
    this.name = "WorkbenchApiError";
    this.status = status;
    this.envelope = envelope;
  }
}

function fallbackError(status: number): ApiErrorEnvelope {
  return {
    error: {
      code: "internal_error",
      message: `工作台请求失败（HTTP ${status}）`,
      impact: "本次操作未完成",
      preservedState: "当前页面数据保持不变",
      nextAction: "稍后重试",
    },
    requestId: "req_unavailable",
  };
}

async function readError(response: Response): Promise<WorkbenchApiError> {
  try {
    return new WorkbenchApiError(
      response.status,
      (await response.json()) as ApiErrorEnvelope,
    );
  } catch {
    return new WorkbenchApiError(response.status, fallbackError(response.status));
  }
}

function buildWorkbenchUrl(basePath: string, query: WorkbenchQuery): string {
  const params = new URLSearchParams();
  if (query.goalId) params.set("goalId", query.goalId);
  if (query.filter) params.set("filter", query.filter);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const search = params.toString();
  return `${basePath}/api/v1/workbench${search ? `?${search}` : ""}`;
}

export class HttpWorkbenchApi implements WorkbenchApi {
  private readonly cache = new Map<string, CachedWorkbenchResponse>();
  private readonly fetcher: Fetcher;
  private readonly basePath: string;

  constructor(
    fetcher: Fetcher = globalThis.fetch.bind(globalThis),
    basePath = "",
  ) {
    this.fetcher = fetcher;
    this.basePath = basePath;
  }

  async getWorkbench(query: WorkbenchQuery = {}): Promise<WorkbenchResponse> {
    const url = buildWorkbenchUrl(this.basePath, query);
    const cached = this.cache.get(url);
    const headers = new Headers({ accept: "application/json" });
    if (cached) headers.set("if-none-match", cached.etag);

    const response = await this.fetcher(url, { headers });
    if (response.status === 304 && cached) return cached.body;
    if (!response.ok) throw await readError(response);

    const body = (await response.json()) as WorkbenchResponse;
    if (body.data?.schemaVersion !== "workbench.v1") {
      throw new WorkbenchApiError(response.status, {
        error: {
          code: "internal_error",
          message: "工作台响应版本不兼容",
          impact: "新数据未应用",
          preservedState: "当前页面数据保持不变",
          nextAction: "刷新页面或联系管理员",
        },
        requestId: body.requestId ?? "req_unavailable",
      });
    }

    const etag = response.headers.get("etag");
    if (etag) this.cache.set(url, { etag, body });
    return body;
  }

  async getTask(taskId: string): Promise<TaskDetailResponse> {
    const response = await this.fetcher(
      `${this.basePath}/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) throw await readError(response);
    return (await response.json()) as TaskDetailResponse;
  }

  async executeTaskAction(
    taskId: string,
    request: ExecuteTaskActionRequest,
    idempotencyKey: string,
  ): Promise<CommandReceipt> {
    const response = await this.fetcher(
      `${this.basePath}/api/v1/tasks/${encodeURIComponent(taskId)}/actions`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) throw await readError(response);
    return (await response.json()) as CommandReceipt;
  }
}

export const workbenchApi: WorkbenchApi = new HttpWorkbenchApi();
