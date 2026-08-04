import type { CapabilityTier } from "../domain/model-router.ts";

export type SchedulerJobState =
  | "pending"
  | "claimed"
  | "starting"
  | "running"
  | "retry_wait"
  | "reconciling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked";

export interface SchedulerJob {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  runId: string;
  issueId?: string;
  externalTaskId: string;
  requiredCapability: CapabilityTier;
  state: SchedulerJobState;
  phase: string;
  priority: number;
  attempt: number;
  maxAttempts: number;
  budget: Readonly<Record<string, unknown>>;
  deadlineAt: string;
  nextAttemptAt: string;
  externalRunId: string | null;
  nodeId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  lastEventSequence: number;
  reconciliationRequired: boolean;
  stopRequested?: boolean;
  failureCode?: string;
  failureReason?: string;
  version: number;
}

export interface ExecutionNodeRecord {
  id: string;
  name: string;
  provider: string;
  capabilities: readonly string[];
  maxConcurrentRuns: number;
  status: "online" | "draining" | "offline";
  heartbeatAt: string;
  offlineAfter: string;
  version: number;
}

export interface ExecutionLeaseRecord {
  id: string;
  runId: string;
  nodeId: string;
  ownerId: string;
  token: string;
  status: "active" | "released" | "expired";
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  version: number;
}

export interface SchedulerRepository {
  listForReconciliation(now: Date): Promise<readonly SchedulerJob[]>;
  heartbeatOwned(input: {
    ownerId: string;
    now: Date;
    expiresAt: Date;
  }): Promise<number>;
  claimNext(now: Date, supervisorId: string): Promise<SchedulerJob | null>;
  selectNode(job: SchedulerJob, now: Date): Promise<ExecutionNodeRecord | null>;
  acquireLease(input: {
    runId: string;
    nodeId: string;
    ownerId: string;
    now: Date;
    expiresAt: Date;
  }): Promise<ExecutionLeaseRecord | null>;
  markExternalStartIssued(input: {
    jobId: string;
    expectedVersion: number;
    externalRunId: string;
    lease: ExecutionLeaseRecord;
    now: Date;
  }): Promise<SchedulerJob>;
  markStarted(jobId: string, external: {
    state: string;
    phase: string;
  }, now: Date): Promise<SchedulerJob>;
  reconcileExternal(jobId: string, external: {
    state: string;
    phase: string;
    message?: string;
  } | null, now: Date): Promise<SchedulerJob>;
  markStopped(jobId: string, now: Date): Promise<SchedulerJob>;
  markTimedOut(jobId: string, now: Date): Promise<SchedulerJob>;
  handleStartFailure(input: {
    jobId: string;
    failureCode: string;
    failureReason: string;
    now: Date;
  }): Promise<SchedulerJob>;
  releaseClaim(jobId: string, reason: string, now: Date): Promise<void>;
}
