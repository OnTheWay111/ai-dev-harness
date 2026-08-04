import type { ExecutionGatewayPort } from "../ports/execution-gateway-port.ts";
import type {
  SchedulerJob,
  SchedulerRepository,
} from "../ports/scheduler-repository.ts";

export interface SchedulerTickResult {
  action: "idle" | "started" | "reconciled" | "capacity_wait" | "retry_scheduled";
  jobId?: string;
}

export interface SchedulerSupervisorDependencies {
  repository: SchedulerRepository;
  gateway: ExecutionGatewayPort;
  supervisorId: string;
  leaseDurationMs: number;
  clock?: () => Date;
  afterExternalStart?: (job: SchedulerJob) => void | Promise<void>;
  selectedSecrets?: readonly string[];
}

function gatewayTimeoutMs(job: SchedulerJob, now: Date): number {
  const deadlineMs = new Date(job.deadlineAt).getTime() - now.getTime();
  const seconds = job.budget.maxRuntimeSeconds;
  const runtimeMs = typeof seconds === "number" &&
      Number.isSafeInteger(seconds) && seconds > 0
    ? seconds * 1000
    : deadlineMs;
  return Math.max(1, Math.min(deadlineMs, runtimeMs));
}

export class SchedulerSupervisor {
  private readonly repository: SchedulerRepository;
  private readonly gateway: ExecutionGatewayPort;
  private readonly supervisorId: string;
  private readonly leaseDurationMs: number;
  private readonly clock: () => Date;
  private readonly afterExternalStart?: (job: SchedulerJob) => void | Promise<void>;
  private readonly selectedSecrets: readonly string[];

  constructor(dependencies: SchedulerSupervisorDependencies) {
    this.repository = dependencies.repository;
    this.gateway = dependencies.gateway;
    this.supervisorId = dependencies.supervisorId;
    this.leaseDurationMs = dependencies.leaseDurationMs;
    this.clock = dependencies.clock ?? (() => new Date());
    this.afterExternalStart = dependencies.afterExternalStart;
    this.selectedSecrets = dependencies.selectedSecrets ?? [];
  }

  async tick(): Promise<SchedulerTickResult> {
    const now = this.clock();
    const reconciliation = await this.repository.listForReconciliation(now);
    if (reconciliation.length > 0) {
      for (const job of reconciliation) await this.reconcile(job, now);
      return { action: "reconciled", jobId: reconciliation[0]?.id };
    }
    await this.repository.heartbeatOwned({
      ownerId: this.supervisorId,
      now,
      expiresAt: new Date(now.getTime() + this.leaseDurationMs),
    });

    const claimed = await this.repository.claimNext(now, this.supervisorId);
    if (!claimed) return { action: "idle" };
    const node = await this.repository.selectNode(claimed, now);
    if (!node) {
      await this.repository.releaseClaim(claimed.id, "No compatible capacity", now);
      return { action: "capacity_wait", jobId: claimed.id };
    }
    const lease = await this.repository.acquireLease({
      runId: claimed.runId,
      nodeId: node.id,
      ownerId: this.supervisorId,
      now,
      expiresAt: new Date(now.getTime() + this.leaseDurationMs),
    });
    if (!lease) {
      await this.repository.releaseClaim(claimed.id, "Capacity lease unavailable", now);
      return { action: "capacity_wait", jobId: claimed.id };
    }

    const externalRunId = `cp-${claimed.runId}-a${claimed.attempt}`;
    const starting = await this.repository.markExternalStartIssued({
      jobId: claimed.id,
      expectedVersion: claimed.version,
      externalRunId,
      lease,
      now,
    });
    let external;
    try {
      external = await this.gateway.start({
        externalTaskId: claimed.externalTaskId,
        externalRunId,
        selectedSecrets: this.selectedSecrets,
        timeoutMs: gatewayTimeoutMs(claimed, now),
      });
    } catch (error) {
      await this.repository.handleStartFailure({
        jobId: claimed.id,
        failureCode: "gateway_start_failed",
        failureReason: error instanceof Error ? error.message : "Execution gateway failed",
        now: this.clock(),
      });
      return { action: "retry_scheduled", jobId: claimed.id };
    }
    await this.afterExternalStart?.(starting);
    await this.repository.markStarted(claimed.id, external, this.clock());
    return { action: "started", jobId: claimed.id };
  }

  private async reconcile(job: SchedulerJob, now: Date): Promise<void> {
    if (job.stopRequested) {
      if (job.externalRunId) await this.gateway.cancel(job.externalRunId);
      await this.repository.markStopped(job.id, now);
      return;
    }
    if (new Date(job.deadlineAt) <= now) {
      if (job.externalRunId) await this.gateway.cancel(job.externalRunId);
      await this.repository.markTimedOut(job.id, now);
      return;
    }
    const external = job.externalRunId
      ? await this.gateway.inspect(job.externalRunId)
      : null;
    await this.repository.reconcileExternal(job.id, external, now);
  }
}
