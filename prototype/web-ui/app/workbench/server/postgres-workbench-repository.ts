import type {
  GlobalTask,
  TaskFilter,
  WorkbenchQuery,
  WorkbenchSnapshot,
} from "../contracts";
import type { ActorVisibilityScope } from "../../auth/visibility-scope.ts";
import {
  decodeWorkbenchCursor,
  encodeWorkbenchCursor,
  type WorkbenchPage,
  type WorkbenchReadRepository,
  WorkbenchRepositoryError,
} from "./workbench-repository.ts";

export interface PersistedWorkbenchSnapshot {
  revision: number;
  generatedAt: Date;
  summary: WorkbenchSnapshot["summary"];
  cacheTag: string;
}

export interface ReadPersistedTasksInput {
  scopeId: string;
  visibility: ActorVisibilityScope;
  goalId?: string;
  filter?: TaskFilter;
  offset: number;
  limit: number;
}

export interface PersistedWorkbenchPage {
  snapshot: PersistedWorkbenchSnapshot | null;
  tasks: GlobalTask[];
  total: number;
}

export interface WorkbenchSummaryCounts {
  all: number;
  attention: number;
  running: number;
  review: number;
  blocked: number;
  waiting: number;
  activeWorkers: number;
}

export function buildScopedWorkbenchSummary(
  counts: WorkbenchSummaryCounts,
): WorkbenchSnapshot["summary"] {
  return {
    taskCounts: {
      all: counts.all,
      attention: counts.attention,
      running: counts.running,
      review: counts.review,
      blocked: counts.blocked,
      waiting: counts.waiting,
    },
    metrics: [
      {
        id: "attention",
        label: "需处理",
        value: String(counts.attention),
        detail: "当前可见范围",
        targetFilter: "attention",
      },
      {
        id: "running",
        label: "执行中",
        value: String(counts.running),
        detail: "当前可见范围",
        targetFilter: "running",
      },
      {
        id: "active_workers",
        label: "活跃 Worker",
        value: String(counts.activeWorkers),
        detail: "当前可见范围",
        targetView: "scheduler",
      },
      {
        id: "blocked",
        label: "阻塞",
        value: String(counts.blocked),
        detail: "当前可见范围",
        tone: counts.blocked > 0 ? "danger" : "default",
        targetFilter: "blocked",
      },
    ],
  };
}

export interface PostgresWorkbenchReadStore {
  readPage(
    input: ReadPersistedTasksInput,
  ): Promise<PersistedWorkbenchPage>;
}

export class PostgresWorkbenchReadRepository
  implements WorkbenchReadRepository
{
  readonly kind = "postgres" as const;
  private readonly store: PostgresWorkbenchReadStore;
  private readonly scopeId: string;

  constructor(store: PostgresWorkbenchReadStore, scopeId: string) {
    this.store = store;
    this.scopeId = scopeId;
  }

  async getWorkbench(
    visibility: ActorVisibilityScope,
    query: WorkbenchQuery = {},
  ): Promise<WorkbenchPage> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new WorkbenchRepositoryError(
        "limit 必须是 1 到 100 的整数",
        "limit",
      );
    }
    const offset = decodeWorkbenchCursor(query.cursor);

    const page = await this.store.readPage({
      scopeId: this.scopeId,
      visibility,
      goalId: query.goalId,
      filter: query.filter,
      offset,
      limit,
    });

    if (!page.snapshot) {
      throw new Error(
        `Workbench snapshot is unavailable for scope ${this.scopeId}`,
      );
    }
    if (offset > page.total) {
      throw new WorkbenchRepositoryError(
        "cursor 超出当前结果范围",
        "cursor",
      );
    }

    const nextOffset = offset + page.tasks.length;
    return {
      data: {
        schemaVersion: "workbench.v1",
        revision: page.snapshot.revision,
        generatedAt: page.snapshot.generatedAt.toISOString(),
        summary: page.snapshot.summary,
        tasks: page.tasks,
      },
      page: {
        nextCursor:
          nextOffset < page.total
            ? encodeWorkbenchCursor(nextOffset)
            : null,
        total: page.total,
      },
      cacheTag: page.snapshot.cacheTag,
    };
  }
}
