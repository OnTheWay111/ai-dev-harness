import type {
  TaskFilter,
  WorkbenchQuery,
  WorkbenchResponse,
} from "../contracts";
import { filterGlobalTasks } from "../selectors.ts";
import { workbenchSnapshot } from "./demo-workbench-snapshot.ts";

export type WorkbenchPage = Omit<WorkbenchResponse, "requestId">;
export type WorkbenchRepositoryKind = "demo" | "postgres";

export interface WorkbenchReadRepository {
  readonly kind: WorkbenchRepositoryKind;
  getWorkbench(query?: WorkbenchQuery): Promise<WorkbenchPage>;
}

export class WorkbenchRepositoryError extends Error {
  readonly field: keyof WorkbenchQuery;

  constructor(
    message: string,
    field: keyof WorkbenchQuery,
  ) {
    super(message);
    this.name = "WorkbenchRepositoryError";
    this.field = field;
  }
}

const defaultLimit = 50;

export function decodeWorkbenchCursor(cursor?: string): number {
  if (!cursor) return 0;
  const match = /^wb1_(\d+)$/.exec(cursor);
  if (!match) {
    throw new WorkbenchRepositoryError("cursor 格式无效或已过期", "cursor");
  }
  return Number(match[1]);
}

export function encodeWorkbenchCursor(offset: number): string {
  return `wb1_${offset}`;
}

function normalizeFilter(filter?: TaskFilter): TaskFilter {
  return filter ?? "all";
}

export class DemoWorkbenchReadRepository implements WorkbenchReadRepository {
  readonly kind = "demo" as const;

  async getWorkbench(query: WorkbenchQuery = {}): Promise<WorkbenchPage> {
    const limit = query.limit ?? defaultLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new WorkbenchRepositoryError("limit 必须是 1 到 100 的整数", "limit");
    }

    const goalTasks = query.goalId
      ? workbenchSnapshot.tasks.filter((task) => task.goalId === query.goalId)
      : workbenchSnapshot.tasks;
    const filteredTasks = filterGlobalTasks(
      goalTasks,
      normalizeFilter(query.filter),
    );
    const offset = decodeWorkbenchCursor(query.cursor);
    if (offset > filteredTasks.length) {
      throw new WorkbenchRepositoryError("cursor 超出当前结果范围", "cursor");
    }

    const tasks = filteredTasks.slice(offset, offset + limit);
    const nextOffset = offset + tasks.length;

    return {
      data: {
        ...workbenchSnapshot,
        tasks,
      },
      page: {
        nextCursor:
          nextOffset < filteredTasks.length
            ? encodeWorkbenchCursor(nextOffset)
            : null,
        total: filteredTasks.length,
      },
    };
  }
}

export const demoWorkbenchRepository: WorkbenchReadRepository =
  new DemoWorkbenchReadRepository();
