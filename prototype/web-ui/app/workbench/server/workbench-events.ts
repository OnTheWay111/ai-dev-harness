export interface WorkbenchRevisionNotice {
  revision: number;
  generatedAt: string;
}

export interface WorkbenchRevisionFeed {
  events(
    afterRevision: number,
    signal: AbortSignal,
  ): AsyncIterable<WorkbenchRevisionNotice>;
}

export function formatWorkbenchInvalidationEvent(
  notice: WorkbenchRevisionNotice,
): string {
  return [
    `id: ${notice.revision}`,
    "event: workbench.snapshot.invalidated",
    `data: ${JSON.stringify({
      revision: notice.revision,
      generatedAt: notice.generatedAt,
    })}`,
    "",
    "",
  ].join("\n");
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class PollingWorkbenchRevisionFeed implements WorkbenchRevisionFeed {
  private readonly read: () => Promise<WorkbenchRevisionNotice>;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly intervalMs: number;

  constructor(input: {
    read: () => Promise<WorkbenchRevisionNotice>;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    intervalMs?: number;
  }) {
    this.read = input.read;
    this.wait = input.wait ?? defaultWait;
    this.intervalMs = input.intervalMs ?? 1_000;
  }

  async *events(
    afterRevision: number,
    signal: AbortSignal,
  ): AsyncIterable<WorkbenchRevisionNotice> {
    let current = afterRevision;
    while (!signal.aborted) {
      const notice = await this.read();
      if (notice.revision > current) {
        current = notice.revision;
        yield notice;
      }
      await this.wait(this.intervalMs, signal);
    }
  }
}

export function createWorkbenchEventsHandler(input: {
  resolveRevision(request: Request): Promise<WorkbenchRevisionNotice | null>;
  heartbeatMs?: number;
  pollIntervalMs?: number;
}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const requested = url.searchParams.get("afterRevision") ??
      request.headers.get("last-event-id") ?? "0";
    if ([...url.searchParams.keys()].some((key) => key !== "afterRevision") ||
      !/^\d+$/.test(requested) || !Number.isSafeInteger(Number(requested))) {
      return new Response(JSON.stringify({
        error: {
          code: "validation_failed",
          message: "afterRevision 必须是非负整数",
          impact: "实时连接未建立",
          preservedState: "浏览器继续保留上次成功数据",
          nextAction: "使用当前快照 revision 重新连接",
        },
        requestId: `req_${crypto.randomUUID()}`,
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    let initial: WorkbenchRevisionNotice | null;
    try {
      initial = await input.resolveRevision(request);
    } catch {
      return new Response(JSON.stringify({
        error: {
          code: "service_unavailable",
          message: "实时服务暂时不可用",
          impact: "实时连接未建立",
          preservedState: "浏览器继续保留上次成功数据",
          nextAction: "稍后使用当前快照 revision 重新连接",
        },
        requestId: `req_${crypto.randomUUID()}`,
      }), {
        status: 503,
        headers: {
          "cache-control": "private, no-store",
          "content-type": "application/json",
        },
      });
    }
    if (!initial) {
      return new Response(JSON.stringify({
        error: {
          code: "forbidden",
          message: "没有可建立实时连接的可见项目",
          impact: "实时连接未建立",
          preservedState: "未返回任何组织或项目数据",
          nextAction: "重新登录或联系管理员分配角色",
        },
        requestId: `req_${crypto.randomUUID()}`,
      }), {
        status: 403,
        headers: {
          "cache-control": "private, no-store",
          "content-type": "application/json",
        },
      });
    }

    const encoder = new TextEncoder();
    const abort = new AbortController();
    request.signal.addEventListener("abort", () => abort.abort(), { once: true });
    let lastRevision = Number(requested);
    const feed = new PollingWorkbenchRevisionFeed({
      read: async () => {
        const notice = await input.resolveRevision(request);
        if (!notice) throw new Error("Workbench visibility was revoked");
        return notice;
      },
      intervalMs: input.pollIntervalMs ?? 1_000,
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const heartbeat = setInterval(() => {
          if (!abort.signal.aborted) {
            controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
          }
        }, input.heartbeatMs ?? 15_000);
        void (async () => {
          try {
            if (initial.revision > lastRevision) {
              lastRevision = initial.revision;
              controller.enqueue(encoder.encode(formatWorkbenchInvalidationEvent(initial)));
            }
            for await (const notice of feed.events(lastRevision, abort.signal)) {
              if (abort.signal.aborted) break;
              lastRevision = notice.revision;
              controller.enqueue(encoder.encode(formatWorkbenchInvalidationEvent(notice)));
            }
          } catch {
            // The browser reconnects with the last revision. Do not serialize
            // database or authorization internals into the event stream.
          } finally {
            clearInterval(heartbeat);
            controller.close();
          }
        })();
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(body, {
      headers: {
        "cache-control": "private, no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
  };
}
