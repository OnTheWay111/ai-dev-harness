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
  authoritativeSummaries: readonly WorkbenchSnapshot["summary"][] = [],
): WorkbenchSnapshot["summary"] {
  const metrics = authoritativeSummaries.flatMap((summary) => summary.metrics);
  const sumMetric = (id: string) => metrics
    .filter((metric) => metric.id === id)
    .reduce((sum, metric) => sum + (Number.parseInt(metric.value, 10) || 0), 0);
  const capacity = metrics
    .filter((metric) => metric.id === "active_workers")
    .reduce((sum, metric) => sum + (Number.parseInt(metric.suffix?.replace("/", "") ?? "0", 10) || 0), 0);
  const budgetValues = metrics
    .filter((metric) => metric.id === "budget_health")
    .map((metric) => metric.value);
  const budgetHealth = budgetValues.includes("超限")
    ? "超限"
    : budgetValues.includes("告警")
    ? "告警"
    : "健康";
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
        value: String(authoritativeSummaries.length > 0
          ? sumMetric("active_workers")
          : counts.activeWorkers),
        suffix: authoritativeSummaries.length > 0 ? `/${capacity}` : undefined,
        detail: "有效 lease / 可见项目容量",
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
      {
        id: "completed_today",
        label: "今日完成",
        value: String(sumMetric("completed_today")),
        detail: "当前可见范围",
        tone: sumMetric("completed_today") > 0 ? "success" : "default",
      },
      {
        id: "budget_health",
        label: "预算健康",
        value: budgetHealth,
        detail: "采用可见项目中的最严重状态",
        tone: budgetHealth === "健康" ? "success" : "danger",
        targetView: "scheduler",
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
