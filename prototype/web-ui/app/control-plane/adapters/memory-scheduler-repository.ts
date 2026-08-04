import type {
  ExecutionLeaseRecord,
  ExecutionNodeRecord,
  SchedulerJob,
  SchedulerRepository,
} from "../ports/scheduler-repository.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function terminal(state: SchedulerJob["state"]): boolean {
  return ["succeeded", "failed", "cancelled", "blocked"].includes(state);
}

export class MemorySchedulerRepository implements SchedulerRepository {
  readonly jobs: SchedulerJob[];
  readonly nodes: ExecutionNodeRecord[];
  readonly leases: ExecutionLeaseRecord[] = [];
  readonly operations: string[] = [];
  readonly outbox: Readonly<Record<string, unknown>>[] = [];

  constructor(seed: {
    jobs?: readonly SchedulerJob[];
    nodes?: readonly ExecutionNodeRecord[];
  } = {}) {
    this.jobs = clone([...(seed.jobs ?? [])]);
    this.nodes = clone([...(seed.nodes ?? [])]);
  }

  get activeLeases(): ExecutionLeaseRecord[] {
    return this.leases.filter((lease) => lease.status === "active");
  }

  async listForReconciliation(now: Date): Promise<readonly SchedulerJob[]> {
    this.operations.push("reconcile:list");
    const offlineNodeIds = new Set<string>();
    for (const node of this.nodes) {
      if (node.status !== "offline" && new Date(node.offlineAfter) <= now) {
        node.status = "offline";
        node.version += 1;
      }
      if (node.status === "offline") offlineNodeIds.add(node.id);
    }
    for (const lease of this.leases) {
      if (lease.status === "active" && (
        new Date(lease.expiresAt) <= now || offlineNodeIds.has(lease.nodeId)
      )) {
        lease.status = "expired";
        lease.releasedAt = now.toISOString();
        lease.version += 1;
        const job = this.jobs.find((candidate) => candidate.runId === lease.runId);
        if (job && !terminal(job.state)) {
          job.reconciliationRequired = true;
          this.outbox.push({
            eventType: "execution.lease_expired",
            jobId: job.id,
            runId: job.runId,
          });
        }
      }
    }
    return clone(this.jobs.filter((job) =>
      !terminal(job.state) && (
        job.stopRequested ||
        job.reconciliationRequired ||
        (["starting", "running", "reconciling"].includes(job.state) &&
          new Date(job.deadlineAt) <= now)
      )
    ));
  }

  async heartbeatOwned(input: {
    ownerId: string;
    now: Date;
    expiresAt: Date;
  }): Promise<number> {
    this.operations.push("lease:heartbeat");
    let renewed = 0;
    for (const lease of this.activeLeases) {
      if (lease.ownerId !== input.ownerId || new Date(lease.expiresAt) <= input.now) continue;
      lease.heartbeatAt = input.now.toISOString();
      lease.expiresAt = input.expiresAt.toISOString();
      lease.version += 1;
      const job = this.jobs.find((candidate) => candidate.runId === lease.runId);
      if (job && !terminal(job.state)) {
        job.heartbeatAt = input.now.toISOString();
        job.leaseExpiresAt = input.expiresAt.toISOString();
      }
      renewed += 1;
    }
    return renewed;
  }

  async claimNext(now: Date, supervisorId: string): Promise<SchedulerJob | null> {
    this.operations.push(`claim:${supervisorId}`);
    const candidate = this.jobs
      .filter((job) =>
        ["pending", "retry_wait"].includes(job.state) &&
        !job.reconciliationRequired &&
        new Date(job.nextAttemptAt) <= now &&
        new Date(job.deadlineAt) > now
      )
      .sort((left, right) =>
        left.priority - right.priority || left.id.localeCompare(right.id)
      )[0];
    if (!candidate) return null;
    candidate.state = "claimed";
    candidate.version += 1;
    candidate.heartbeatAt = now.toISOString();
    return clone(candidate);
  }

  async selectNode(_job: SchedulerJob, now: Date): Promise<ExecutionNodeRecord | null> {
    this.operations.push("node:select");
    const node = this.nodes.find((candidate) => {
      if (candidate.status !== "online" || new Date(candidate.offlineAfter) <= now) {
        return false;
      }
      if (!candidate.capabilities.includes(_job.requiredCapability)) return false;
      return this.activeLeases.filter((lease) => lease.nodeId === candidate.id).length <
        candidate.maxConcurrentRuns;
    });
    return node ? clone(node) : null;
  }

  async acquireLease(input: {
    runId: string;
    nodeId: string;
    ownerId: string;
    now: Date;
    expiresAt: Date;
  }): Promise<ExecutionLeaseRecord | null> {
    this.operations.push("lease:acquire");
    const existing = this.activeLeases.find((lease) => lease.runId === input.runId);
    if (existing) {
      return existing.nodeId === input.nodeId && existing.ownerId === input.ownerId
        ? clone(existing)
        : null;
    }
    const node = this.nodes.find((candidate) => candidate.id === input.nodeId);
    if (!node || node.status !== "online" || node.offlineAfter <= input.now.toISOString()) {
      return null;
    }
    const job = this.jobs.find((candidate) => candidate.runId === input.runId);
    if (!job || !node.capabilities.includes(job.requiredCapability)) return null;
    const used = this.activeLeases.filter((lease) => lease.nodeId === node.id).length;
    if (used >= node.maxConcurrentRuns) return null;
    const lease: ExecutionLeaseRecord = {
      id: crypto.randomUUID(),
      runId: input.runId,
      nodeId: input.nodeId,
      ownerId: input.ownerId,
      token: crypto.randomUUID(),
      status: "active",
      acquiredAt: input.now.toISOString(),
      heartbeatAt: input.now.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      releasedAt: null,
      version: 1,
    };
    this.leases.push(lease);
    return clone(lease);
  }

  async markExternalStartIssued(input: {
    jobId: string;
    expectedVersion: number;
    externalRunId: string;
    lease: ExecutionLeaseRecord;
    now: Date;
  }): Promise<SchedulerJob> {
    this.operations.push("job:starting");
    const job = this.requiredJob(input.jobId);
    if (job.version !== input.expectedVersion || job.state !== "claimed") {
      throw new Error("scheduler job version conflict");
    }
    job.state = "starting";
    job.externalRunId = input.externalRunId;
    job.nodeId = input.lease.nodeId;
    job.leaseToken = input.lease.token;
    job.leaseExpiresAt = input.lease.expiresAt;
    job.heartbeatAt = input.now.toISOString();
    job.reconciliationRequired = true;
    job.version += 1;
    return clone(job);
  }

  async markStarted(jobId: string, external: {
    state: string;
    phase: string;
  }, now: Date): Promise<SchedulerJob> {
    this.operations.push("job:started");
    const job = this.requiredJob(jobId);
    job.state = external.state === "succeeded" ? "succeeded" : "running";
    job.phase = external.phase;
    job.heartbeatAt = now.toISOString();
    job.reconciliationRequired = false;
    job.version += 1;
    this.outbox.push({ eventType: "scheduler.job_started", jobId });
    return clone(job);
  }

  async reconcileExternal(jobId: string, external: {
    state: string;
    phase: string;
    message?: string;
  } | null, now: Date): Promise<SchedulerJob> {
    this.operations.push("job:reconcile");
    const job = this.requiredJob(jobId);
    job.phase = external?.phase ?? "unknown";
    if (!external || external.state === "unknown") {
      job.state = "blocked";
      job.failureCode = "external_state_unknown";
      job.failureReason = "External execution could not be reconciled";
    } else if (external.state === "succeeded") {
      job.state = "succeeded";
    } else if (external.state === "failed") {
      job.state = "failed";
      job.failureCode = "external_failed";
      job.failureReason = external.message ?? "External execution failed";
    } else if (external.state === "cancelled") {
      job.state = "cancelled";
    } else {
      job.state = "running";
    }
    job.heartbeatAt = now.toISOString();
    job.reconciliationRequired = false;
    job.version += 1;
    return clone(job);
  }

  async markTimedOut(jobId: string, now: Date): Promise<SchedulerJob> {
    this.operations.push("job:timeout");
    const job = this.requiredJob(jobId);
    job.state = "failed";
    job.phase = "timeout";
    job.failureCode = "deadline_exceeded";
    job.failureReason = "Execution deadline exceeded";
    job.heartbeatAt = now.toISOString();
    job.reconciliationRequired = false;
    job.version += 1;
    for (const lease of this.activeLeases.filter((value) => value.runId === job.runId)) {
      lease.status = "released";
      lease.releasedAt = now.toISOString();
      lease.version += 1;
    }
    return clone(job);
  }

  async markStopped(jobId: string, now: Date): Promise<SchedulerJob> {
    this.operations.push("job:stopped");
    const job = this.requiredJob(jobId);
    job.state = "cancelled";
    job.phase = "stopped";
    job.failureCode = "operator_stop";
    job.failureReason = "Execution stopped by operator control";
    job.heartbeatAt = now.toISOString();
    job.reconciliationRequired = false;
    job.stopRequested = false;
    job.version += 1;
    for (const lease of this.activeLeases.filter((value) => value.runId === job.runId)) {
      lease.status = "released";
      lease.releasedAt = now.toISOString();
      lease.version += 1;
    }
    return clone(job);
  }

  async handleStartFailure(input: {
    jobId: string;
    failureCode: string;
    failureReason: string;
    now: Date;
  }): Promise<SchedulerJob> {
    this.operations.push("job:start-failed");
    const job = this.requiredJob(input.jobId);
    const retry = job.attempt < job.maxAttempts;
    job.state = retry ? "retry_wait" : "failed";
    if (retry) job.attempt += 1;
    job.nextAttemptAt = new Date(
      input.now.getTime() + Math.min(60_000, 1000 * 2 ** (job.attempt - 1)),
    ).toISOString();
    job.externalRunId = null;
    job.nodeId = null;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.reconciliationRequired = false;
    job.failureCode = input.failureCode;
    job.failureReason = input.failureReason;
    job.version += 1;
    for (const lease of this.activeLeases.filter((value) => value.runId === job.runId)) {
      lease.status = "released";
      lease.releasedAt = input.now.toISOString();
      lease.version += 1;
    }
    return clone(job);
  }

  async releaseClaim(jobId: string, reason: string, now: Date): Promise<void> {
    this.operations.push("claim:release");
    const job = this.requiredJob(jobId);
    job.state = "pending";
    job.failureReason = reason;
    job.nextAttemptAt = now.toISOString();
    job.version += 1;
  }

  private requiredJob(jobId: string): SchedulerJob {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error("scheduler job was not found");
    return job;
  }
}
