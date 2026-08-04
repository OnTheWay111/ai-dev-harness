import type {
  GlobalTask,
  TaskFilter,
  TaskFilterCounts,
  TaskStage,
} from "./contracts";

export interface TaskFilterOption {
  id: TaskFilter;
  label: string;
  count: number;
}
type FilterableTask = Pick<GlobalTask, "stage" | "attention">;

const filterDefinitions: ReadonlyArray<{
  id: TaskFilter;
  label: string;
}> = [
  { id: "all", label: "全部" },
  { id: "attention", label: "需处理" },
  { id: "running", label: "执行中" },
  { id: "review", label: "Review" },
  { id: "blocked", label: "阻塞" },
  { id: "waiting", label: "等待" },
];

export function filterGlobalTasks<T extends FilterableTask>(
  tasks: readonly T[],
  filter: TaskFilter,
): T[] {
  if (filter === "all") return [...tasks];
  if (filter === "attention") {
    return tasks.filter((task) => task.attention.required);
  }
  return tasks.filter((task) => task.stage === filter);
}

export function buildTaskFilters<T extends FilterableTask>(
  tasks: readonly T[],
  serverCounts?: TaskFilterCounts,
): TaskFilterOption[] {
  const stageCounts = tasks.reduce<Record<TaskStage, number>>(
    (counts, task) => {
      counts[task.stage] += 1;
      return counts;
    },
    { running: 0, review: 0, blocked: 0, waiting: 0 },
  );

  return filterDefinitions.map((definition) => {
    if (serverCounts) {
      return { ...definition, count: serverCounts[definition.id] };
    }

    let count: number;
    if (definition.id === "all") count = tasks.length;
    else if (definition.id === "attention") {
      count = tasks.filter((task) => task.attention.required).length;
    } else count = stageCounts[definition.id];

    return { ...definition, count };
  });
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m${seconds ? ` ${seconds}s` : ""}`;
  }
  return `${minutes}m${seconds ? ` ${String(seconds).padStart(2, "0")}s` : ""}`;
}

export function formatClock(isoDate: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(isoDate));
}
