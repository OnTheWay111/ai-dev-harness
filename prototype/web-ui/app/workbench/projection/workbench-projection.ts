import type {
  GlobalTask,
  TaskFilterCounts,
  TaskPriority,
  TaskStage,
  WorkbenchMetric,
  WorkbenchSnapshot,
} from "../contracts.ts";

export interface WorkbenchProjectionScope {
  scopeId: string;
  organizationId: string;
  projectId: string;
}

export interface GoalProjectionFact {
  id: string;
  title: string;
  status: "draft" | "clarifying" | "planning" | "approved" | "executing" | "verifying" | "completed" | "cancelled";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssueProjectionFact {
  id: string;
  goalId: string;
  issueKey: string;
  title: string;
  status: "draft" | "approved" | "ready" | "in_progress" | "blocked" | "completed" | "cancelled";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssueDependencyProjectionFact {
  issueId: string;
  dependsOnIssueId: string;
  dependsOnIssueKey: string;
  satisfied: boolean;
  createdAt: string;
}

export interface RunProjectionFact {
  id: string;
  issueId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  version: number;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface SchedulerJobProjectionFact {
  id: string;
  issueId: string;
  runId: string;
  state: "pending" | "claimed" | "starting" | "running" | "retry_wait" | "reconciling" | "succeeded" | "failed" | "cancelled" | "blocked";
  phase: string;
  priority: number;
  budget: Readonly<Record<string, unknown>>;
  deadlineAt: string;
  nodeId: string | null;
  failureCode: string | null;
  failureReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionNodeProjectionFact {
  id: string;
  name: string;
  status: "online" | "draining" | "offline";
  maxConcurrentRuns: number;
  offlineAfter: string;
  updatedAt: string;
}

export interface ExecutionLeaseProjectionFact {
  runId: string;
  nodeId: string;
  status: "active" | "released" | "expired";
  expiresAt: string;
  heartbeatAt: string;
}

export interface ExecutionControlProjectionFact {
  scopeType: "global" | "project";
  state: "active" | "paused" | "draining" | "stopped";
  circuitOpenUntil: string | null;
  updatedAt: string;
}

export interface WorkbenchProjectionFacts {
  scope: WorkbenchProjectionScope;
  goals: readonly GoalProjectionFact[];
  issues: readonly IssueProjectionFact[];
  dependencies: readonly IssueDependencyProjectionFact[];
  runs: readonly RunProjectionFact[];
  schedulerJobs: readonly SchedulerJobProjectionFact[];
  nodes: readonly ExecutionNodeProjectionFact[];
  leases: readonly ExecutionLeaseProjectionFact[];
  controls: readonly ExecutionControlProjectionFact[];
  evidenceCounts: readonly { issueId: string; count: number; updatedAt: string }[];
}

export interface BuildWorkbenchSnapshotOptions {
  revision: number;
  generatedAt: string;
}

export function workbenchFactsWatermark(
  facts: WorkbenchProjectionFacts,
  fallback: string,
): string {
  const timestamps = [
    ...facts.goals.flatMap((fact) => [fact.createdAt, fact.updatedAt]),
    ...facts.issues.flatMap((fact) => [fact.createdAt, fact.updatedAt]),
    ...facts.runs.flatMap((fact) => [fact.updatedAt, ...(fact.startedAt ? [fact.startedAt] : []), ...(fact.finishedAt ? [fact.finishedAt] : [])]),
    ...facts.schedulerJobs.flatMap((fact) => [fact.createdAt, fact.updatedAt]),
    ...facts.dependencies.map((fact) => fact.createdAt),
    ...facts.nodes.map((fact) => fact.updatedAt),
    ...facts.leases.map((fact) => fact.heartbeatAt),
    ...facts.controls.map((fact) => fact.updatedAt),
    ...facts.evidenceCounts.map((fact) => fact.updatedAt),
  ].filter((value) => Number.isFinite(Date.parse(value)));
  return timestamps.sort(
    (left, right) => Date.parse(right) - Date.parse(left),
  )[0] ?? fallback;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function priorityFor(job: SchedulerJobProjectionFact | undefined): TaskPriority {
  if (!job || job.priority <= 33) return "P0";
  if (job.priority <= 66) return "P1";
  return "P2";
}

function latestBy<T>(values: readonly T[], timestamp: (value: T) => string): T | undefined {
  return [...values].sort((left, right) =>
    timestamp(right).localeCompare(timestamp(left))
  )[0];
}

function stageFor(
  issue: IssueProjectionFact,
  run: RunProjectionFact | undefined,
  job: SchedulerJobProjectionFact | undefined,
): TaskStage {
  if (issue.status === "blocked" || run?.status === "failed" ||
    job?.state === "blocked" || job?.state === "failed") return "blocked";
  if (job?.phase.toLowerCase().includes("review") ||
    job?.phase.toLowerCase().includes("verify")) return "review";
  if (run?.status === "running" || issue.status === "in_progress" ||
    ["claimed", "starting", "running"].includes(job?.state ?? "")) return "running";
  return "waiting";
}

function progressFor(
  issue: IssueProjectionFact,
  run: RunProjectionFact | undefined,
  job: SchedulerJobProjectionFact | undefined,
): number {
  if (issue.status === "completed" || run?.status === "succeeded" || job?.state === "succeeded") return 100;
  if (job?.phase.toLowerCase().includes("landing")) return 95;
  if (job?.phase.toLowerCase().includes("review")) return 90;
  if (job?.phase.toLowerCase().includes("verify")) return 80;
  if (run?.status === "running" || job?.state === "running") return 55;
  if (["claimed", "starting"].includes(job?.state ?? "")) return 35;
  if (issue.status === "in_progress" || issue.status === "blocked") return 30;
  if (issue.status === "ready") return 20;
  if (issue.status === "approved") return 10;
  return 0;
}

function secondsSince(start: string, end: string): number {
  return Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1_000));
}

function conflictKeys(job: SchedulerJobProjectionFact | undefined): string[] {
  const keys = job?.budget.conflictKeys;
  return Array.isArray(keys)
    ? keys.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
}

function issueTask(
  issue: IssueProjectionFact,
  facts: WorkbenchProjectionFacts,
  generatedAt: string,
): GlobalTask {
  const runs = facts.runs.filter((candidate) => candidate.issueId === issue.id);
  const run = latestBy(runs, (candidate) => candidate.updatedAt);
  const jobs = facts.schedulerJobs.filter((candidate) => candidate.issueId === issue.id);
  const job = latestBy(jobs, (candidate) => candidate.updatedAt);
  const stage = stageFor(issue, run, job);
  const dependencies = facts.dependencies.filter((candidate) => candidate.issueId === issue.id);
  const unsatisfied = dependencies.filter((candidate) => !candidate.satisfied);
  const conflicts = conflictKeys(job);
  const control = facts.controls.find((candidate) =>
    candidate.state !== "active" ||
    (candidate.circuitOpenUntil && Date.parse(candidate.circuitOpenUntil) > Date.parse(generatedAt))
  );
  const reconciliation = job?.state === "reconciling";
  const required = stage === "blocked" || reconciliation || Boolean(control);
  const blocking = stage === "blocked" || control?.state === "stopped";
  const dueAt = job?.deadlineAt;
  const waitingFrom = run?.startedAt ?? job?.createdAt ?? issue.createdAt;
  const waitingSeconds = stage === "blocked" || stage === "waiting"
    ? secondsSince(waitingFrom, generatedAt)
    : undefined;
  const blockedTaskCount = unsatisfied.length + conflicts.length;
  const node = job?.nodeId
    ? facts.nodes.find((candidate) => candidate.id === job.nodeId)
    : undefined;
  const evidenceCount = facts.evidenceCounts.find((entry) => entry.issueId === issue.id)?.count ?? 0;
  const rankingParts = [
    dueAt ? `截止 ${new Date(dueAt).toISOString()}` : "无明确截止时间",
    blockedTaskCount > 0 ? `阻塞影响 ${blockedTaskCount} 项` : "无下游阻塞",
    waitingSeconds !== undefined ? `已等待 ${waitingSeconds} 秒` : "正在推进",
  ];
  const status = stage === "blocked"
    ? { code: job?.failureCode ?? "blocked", label: "阻塞", tone: "danger" as const }
    : stage === "review"
    ? { code: "review", label: "Review", tone: "warning" as const }
    : stage === "running"
    ? { code: job?.phase || "running", label: "执行中", tone: "info" as const }
    : { code: reconciliation ? "reconciling" : "waiting", label: reconciliation ? "恢复核对" : "等待", tone: "neutral" as const };
  const action = stage === "blocked"
    ? { id: "resolve_blocker" as const, label: "处理阻塞", available: true, requiredRole: "Operator" as const }
    : stage === "review"
    ? { id: "review_evidence" as const, label: "审查证据", available: true, requiredRole: "Approver" as const }
    : stage === "running"
    ? { id: "inspect_run" as const, label: "查看执行", available: true, requiredRole: "Viewer" as const, targetView: "run" as const }
    : { id: "inspect_schedule" as const, label: "查看调度", available: true, requiredRole: "Viewer" as const, targetView: "scheduler" as const };

  return {
    // Issue keys are only unique inside one Goal. Prefixing the Goal UUID keeps
    // the API/task-row identity stable across projects and issue revisions.
    id: `${issue.goalId}:${issue.issueKey}`,
    // This is the optimistic version of the composite task, not one source
    // row. A change to any authoritative participant must invalidate a command.
    version: issue.version + (run?.version ?? 0) + (job?.version ?? 0),
    goalId: issue.goalId,
    title: issue.title,
    kind: "issue",
    priority: priorityFor(job),
    stage,
    status,
    progress: {
      percent: progressFor(issue, run, job),
      updatedAt: latestBy([
        issue.updatedAt,
        ...(run ? [run.updatedAt] : []),
        ...(job ? [job.updatedAt] : []),
      ], (value) => value) ?? issue.updatedAt,
    },
    attention: {
      required,
      count: required ? Math.max(1, unsatisfied.length + conflicts.length) : 0,
      severity: required ? (blocking ? "blocking" : "warning") : "none",
      headline: required
        ? job?.failureReason ?? (control ? `执行控制为 ${control.state}` : "调度状态需要人工确认")
        : "任务正常推进",
      rankingReason: rankingParts.join(" · "),
      impact: required
        ? `影响 ${issue.issueKey} 及 ${blockedTaskCount} 项依赖或冲突`
        : `${issue.issueKey} 正按权威调度状态推进`,
      dueAt,
      waitingSeconds,
      blockedTaskCount,
    },
    execution: {
      actorType: node ? "worker" : "scheduler",
      actorId: node?.name,
      actorLabel: node?.name ?? "Scheduler",
      elapsedSeconds: secondsSince(run?.startedAt ?? job?.createdAt ?? issue.createdAt, generatedAt),
      nextCheckpoint: stage === "blocked"
        ? "解除阻塞后重新调度"
        : job?.phase || (stage === "waiting" ? "等待领取" : "同步执行状态"),
    },
    action,
    detail: {
      dependency: dependencies.length > 0
        ? dependencies.map((candidate) =>
          `${candidate.dependsOnIssueKey}${candidate.satisfied ? " 已完成" : " 未完成"}`
        ).join(" · ")
        : "无前置依赖",
      evidence: `${evidenceCount} 项持久化证据`,
      workspace: node ? `执行节点 ${node.name}` : "未分配隔离工作区",
    },
  };
}

function goalGateTask(goal: GoalProjectionFact, generatedAt: string): GlobalTask {
  const stage: TaskStage = goal.status === "verifying" ? "review" : "waiting";
  const review = goal.status === "verifying";
  return {
    id: `${goal.id}:GOAL`,
    version: goal.version,
    goalId: goal.id,
    title: goal.title,
    kind: "gate",
    priority: "P0",
    stage,
    status: {
      code: goal.status,
      label: review ? "等待验收" : "等待门禁",
      tone: "warning",
    },
    progress: {
      percent: review ? 95 : goal.status === "approved" ? 25 : 10,
      updatedAt: goal.updatedAt,
    },
    attention: {
      required: true,
      count: 1,
      severity: "warning",
      headline: review ? "Goal 验收待人工确认" : `Goal 仍处于 ${goal.status} 门禁`,
      rankingReason: `门禁等待 ${secondsSince(goal.updatedAt, generatedAt)} 秒`,
      impact: "未通过门禁前不会进入下一执行阶段",
      waitingSeconds: secondsSince(goal.updatedAt, generatedAt),
      blockedTaskCount: 1,
    },
    execution: {
      actorType: "role",
      actorLabel: review ? "Goal Approver" : "Goal Planner",
      elapsedSeconds: secondsSince(goal.updatedAt, generatedAt),
      nextCheckpoint: review ? "确认验收证据" : "完成当前 Goal 门禁",
    },
    action: review
      ? { id: "review_evidence", label: "审查证据", available: true, requiredRole: "Approver", targetView: "verify" }
      : { id: "answer_questions", label: "处理门禁", available: true, requiredRole: "Approver", targetView: "clarify" },
    detail: {
      dependency: `Goal v${goal.version}`,
      evidence: "等待领域门禁证据",
      workspace: "Goal Workspace",
    },
  };
}

const priorityRank: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2 };

export function compareGlobalTasks(left: GlobalTask, right: GlobalTask): number {
  if (left.attention.required !== right.attention.required) {
    return left.attention.required ? -1 : 1;
  }
  const priority = priorityRank[left.priority] - priorityRank[right.priority];
  if (priority !== 0) return priority;
  const leftDue = left.attention.dueAt ? Date.parse(left.attention.dueAt) : Number.POSITIVE_INFINITY;
  const rightDue = right.attention.dueAt ? Date.parse(right.attention.dueAt) : Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) return leftDue - rightDue;
  const blocked = (right.attention.blockedTaskCount ?? 0) - (left.attention.blockedTaskCount ?? 0);
  if (blocked !== 0) return blocked;
  const waiting = (right.attention.waitingSeconds ?? 0) - (left.attention.waitingSeconds ?? 0);
  if (waiting !== 0) return waiting;
  return left.id.localeCompare(right.id);
}

function dayKey(value: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function metrics(
  facts: WorkbenchProjectionFacts,
  tasks: readonly GlobalTask[],
  generatedAt: string,
): WorkbenchMetric[] {
  const now = Date.parse(generatedAt);
  const activeNodeIds = new Set(facts.leases
    .filter((lease) => lease.status === "active" && Date.parse(lease.expiresAt) > now)
    .map((lease) => lease.nodeId));
  const onlineNodes = facts.nodes.filter((node) =>
    node.status === "online" && Date.parse(node.offlineAfter) > now
  );
  const capacity = onlineNodes.reduce((sum, node) => sum + Math.max(0, node.maxConcurrentRuns), 0);
  const completedToday = facts.runs.filter((run) =>
    run.status === "succeeded" && run.finishedAt && dayKey(run.finishedAt) === dayKey(generatedAt)
  ).length;
  let tokensUsed = 0;
  let tokenLimit = 0;
  for (const job of facts.schedulerJobs) {
    tokensUsed += numeric(job.budget.tokensUsed) ?? 0;
    tokenLimit += numeric(job.budget.tokenLimit) ?? 0;
  }
  const budgetRatio = tokenLimit > 0 ? tokensUsed / tokenLimit : 0;
  const budgetHealth = budgetRatio > 1 ? "超限" : budgetRatio >= 0.85 ? "告警" : "健康";
  const attention = tasks.filter((task) => task.attention.required).length;
  const running = tasks.filter((task) => task.stage === "running").length;
  const blocked = tasks.filter((task) => task.stage === "blocked").length;
  return [
    { id: "attention", label: "需处理", value: String(attention), detail: "权威门禁与阻塞", tone: attention > 0 ? "danger" : "default", targetFilter: "attention" },
    { id: "running", label: "执行中", value: String(running), detail: "Run / Scheduler 正在推进", targetFilter: "running" },
    { id: "active_workers", label: "活跃 Worker", value: String(activeNodeIds.size), suffix: `/${capacity}`, detail: "有效 lease / 在线容量", targetView: "scheduler" },
    { id: "blocked", label: "阻塞", value: String(blocked), detail: "领域或调度阻塞", tone: blocked > 0 ? "danger" : "default", targetFilter: "blocked" },
    { id: "completed_today", label: "今日完成", value: String(completedToday), detail: "Asia/Shanghai 成功 Run", tone: completedToday > 0 ? "success" : "default" },
    { id: "budget_health", label: "预算健康", value: budgetHealth, detail: tokenLimit > 0 ? `${tokensUsed}/${tokenLimit} tokens` : "尚无预算消耗", tone: budgetHealth === "健康" ? "success" : "danger", targetView: "scheduler" },
  ];
}

function taskCounts(tasks: readonly GlobalTask[]): TaskFilterCounts {
  return {
    all: tasks.length,
    attention: tasks.filter((task) => task.attention.required).length,
    running: tasks.filter((task) => task.stage === "running").length,
    review: tasks.filter((task) => task.stage === "review").length,
    blocked: tasks.filter((task) => task.stage === "blocked").length,
    waiting: tasks.filter((task) => task.stage === "waiting").length,
  };
}

export function buildWorkbenchSnapshot(
  facts: WorkbenchProjectionFacts,
  options: BuildWorkbenchSnapshotOptions,
): WorkbenchSnapshot {
  if (!Number.isSafeInteger(options.revision) || options.revision < 0) {
    throw new Error("Workbench revision must be a non-negative safe integer");
  }
  if (!Number.isFinite(Date.parse(options.generatedAt))) {
    throw new Error("Workbench generatedAt must be an ISO timestamp");
  }
  const tasks = [
    ...facts.issues
      .filter((issue) => !["completed", "cancelled"].includes(issue.status))
      .map((issue) => issueTask(issue, facts, options.generatedAt)),
    ...facts.goals
      .filter((goal) => !["executing", "completed", "cancelled"].includes(goal.status))
      .map((goal) => goalGateTask(goal, options.generatedAt)),
  ].sort(compareGlobalTasks);
  return {
    schemaVersion: "workbench.v1",
    revision: options.revision,
    generatedAt: options.generatedAt,
    summary: {
      metrics: metrics(facts, tasks, options.generatedAt),
      taskCounts: taskCounts(tasks),
    },
    tasks,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export async function workbenchSemanticDigest(snapshot: WorkbenchSnapshot): Promise<string> {
  const semantic = canonical({
    schemaVersion: snapshot.schemaVersion,
    summary: snapshot.summary,
    tasks: snapshot.tasks,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(semantic)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
