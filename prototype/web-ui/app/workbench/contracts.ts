export type View =
  | "overview"
  | "scheduler"
  | "clarify"
  | "issues"
  | "run"
  | "verify";

export type TaskFilter =
  | "all"
  | "attention"
  | "running"
  | "review"
  | "blocked"
  | "waiting";

export type StatusTone =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral";

export type TaskPriority = "P0" | "P1" | "P2";
export type TaskStage = Exclude<TaskFilter, "all" | "attention">;
export type TaskKind = "issue" | "gate" | "scheduling";
export type TaskFilterCounts = Record<TaskFilter, number>;

export interface TaskStatus {
  code: string;
  label: string;
  tone: Exclude<StatusTone, "success">;
}

export interface TaskProgress {
  percent: number;
  completedUnits?: number;
  totalUnits?: number;
  updatedAt: string;
}

export interface TaskAttention {
  required: boolean;
  count: number;
  severity: "none" | "warning" | "blocking";
  headline: string;
  rankingReason: string;
  impact: string;
  dueAt?: string;
  waitingSeconds?: number;
  blockedTaskCount?: number;
}

export interface TaskExecutionContext {
  actorType: "worker" | "scheduler" | "role";
  actorId?: string;
  actorLabel: string;
  elapsedSeconds: number;
  nextCheckpoint: string;
}

export interface TaskAction {
  id:
    | "review_evidence"
    | "answer_questions"
    | "resolve_blocker"
    | "inspect_schedule"
    | "inspect_run";
  label: string;
  available: boolean;
  requiredRole?: "Approver" | "Operator" | "Viewer";
  unavailableReason?: string;
  targetView?: View;
  successMessage?: string;
}

export interface GlobalTask {
  id: string;
  version: number;
  goalId: string;
  title: string;
  kind: TaskKind;
  priority: TaskPriority;
  stage: TaskStage;
  status: TaskStatus;
  progress: TaskProgress;
  attention: TaskAttention;
  execution: TaskExecutionContext;
  action: TaskAction;
  detail: {
    dependency: string;
    evidence: string;
    workspace: string;
  };
  deliveryEvidence?: DeliveryEvidenceSummary;
}

export interface DeliveryEvidenceArtifactSummary {
  id: string;
  kind: "prompt" | "run_log" | "test_output" | "build_result" | "failure_evidence";
  digest: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface DeliveryEvidenceSummary {
  artifacts: readonly DeliveryEvidenceArtifactSummary[];
  latestReview?: {
    verdict: "approved" | "request_changes" | "rejected";
    reviewerType: "human" | "model";
    reviewerVersion: string;
    targetCommitSha: string;
    reviewedAt: string;
  };
  commitSha?: string;
  push?: {
    remoteBranch: string;
    commitSha: string;
    pushedAt: string;
  };
  pullRequest?: {
    externalId: string;
    url: string;
    status: "open" | "merged" | "closed";
  };
  landing?: {
    commitSha: string;
    landedAt: string;
  };
}

export type WorkbenchMetricId =
  | "attention"
  | "running"
  | "active_workers"
  | "blocked"
  | "completed_today"
  | "budget_health";

export interface WorkbenchMetric {
  id: WorkbenchMetricId;
  label: string;
  value: string;
  suffix?: string;
  detail: string;
  detailEmphasis?: string;
  tone?: "default" | "danger" | "success";
  targetFilter?: TaskFilter;
  targetView?: View;
}

export interface WorkbenchSnapshot {
  schemaVersion: "workbench.v1";
  revision: number;
  generatedAt: string;
  summary: {
    metrics: WorkbenchMetric[];
    taskCounts: TaskFilterCounts;
  };
  tasks: GlobalTask[];
}

export interface WorkbenchQuery {
  goalId?: string;
  filter?: TaskFilter;
  cursor?: string;
  limit?: number;
}

export interface WorkbenchResponse {
  data: WorkbenchSnapshot;
  page: {
    nextCursor: string | null;
    total: number;
  };
  requestId: string;
}

export interface TaskDetailResponse {
  data: GlobalTask;
  requestId: string;
}

export interface ExecuteTaskActionRequest {
  action: TaskAction["id"];
  expectedVersion: number;
  reason?: string;
  input?: Record<string, unknown>;
}

export interface CommandReceipt {
  receiptId: string;
  requestId: string;
  status: "accepted" | "running" | "completed" | "failed";
  taskId: string;
  taskVersion: number;
  submittedAt: string;
  statusUrl: string;
  completedAt?: string;
  error?: {
    code: string;
    message?: string;
    nextAction?: string;
  };
}

export interface ArtifactDownloadGrant {
  artifact: DeliveryEvidenceArtifactSummary;
  downloadUrl: string;
  expiresAt: string;
  requestId: string;
}

export interface ApiErrorEnvelope {
  error: {
    code:
      | "validation_failed"
      | "forbidden"
      | "not_found"
      | "version_conflict"
      | "idempotency_conflict"
      | "invalid_transition"
      | "rate_limited"
      | "service_unavailable"
      | "internal_error";
    message: string;
    impact: string;
    preservedState: string;
    nextAction?: string;
    fieldErrors?: Record<string, string[]>;
  };
  requestId: string;
}

export interface WorkbenchApi {
  getWorkbench(query?: WorkbenchQuery): Promise<WorkbenchResponse>;
  getTask(taskId: string): Promise<TaskDetailResponse>;
  executeTaskAction(
    taskId: string,
    request: ExecuteTaskActionRequest,
    idempotencyKey: string,
  ): Promise<CommandReceipt>;
  getReceipt(receiptId: string): Promise<CommandReceipt>;
  createArtifactDownload(artifactId: string): Promise<ArtifactDownloadGrant>;
}

export interface NavItem {
  id: View;
  label: string;
  short: string;
  badge?: string;
}

export interface IssuePlanRow {
  id: string;
  title: string;
  area: string;
  depends: string;
  files: string;
  model: string;
  effort: string;
  status: string;
}

export interface SchedulerCandidate {
  priority: TaskPriority;
  issue: string;
  title: string;
  goal: string;
  gate: string;
  conflict: string;
  status: string;
  tone: StatusTone;
}
