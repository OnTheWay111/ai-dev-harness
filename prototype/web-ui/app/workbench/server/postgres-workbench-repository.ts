import type {
  GlobalTask,
  TaskFilter,
  WorkbenchQuery,
  WorkbenchSnapshot,
} from "../contracts";
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
}

export interface ReadPersistedTasksInput {
  scopeId: string;
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

  async getWorkbench(query: WorkbenchQuery = {}): Promise<WorkbenchPage> {
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
    };
  }
}
