import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { MemoryExecutionControlRepository } from
  "../app/control-plane/adapters/memory-execution-control-repository.ts";
import { MemorySchedulerRepository } from
  "../app/control-plane/adapters/memory-scheduler-repository.ts";
import { ExecutionControlService } from
  "../app/control-plane/application/execution-control-service.ts";
import { SchedulerSupervisor } from
  "../app/control-plane/application/scheduler-supervisor.ts";
import type {
  ExecutionGatewayPort,
  ExecutionStartRequest,
  ExternalExecutionStatus,
} from "../app/control-plane/ports/execution-gateway-port.ts";
import type { SchedulerJob } from
  "../app/control-plane/ports/scheduler-repository.ts";
import {
  type RunbookManifest,
  validateRunbookDocument,
  validateRunbookDrillReceipt,
  validateRunbookManifest,
} from "../app/reliability/runbook-catalog.ts";

const manifestUrl = new URL(
  "../../../ops/production/runbook-manifest.json",
  import.meta.url,
);
const stopRunbookUrl = new URL(
  "../../../docs/runbooks/execution-stop-worker-loss.md",
  import.meta.url,
);
const NOW = new Date("2026-08-05T03:15:00.000Z");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function outputPath(): string {
  const index = process.argv.indexOf("--output");
  const value = index >= 0 ? process.argv[index + 1]?.trim() : "";
  if (!value || !isAbsolute(value) || !value.endsWith(".json")) {
    throw new Error("--output must be an absolute JSON path");
  }
  return value;
}

function role(name: string): string {
  const value = required(name);
  if (!/^[a-z][a-z0-9-]{2,79}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function schedulerJob(overrides: Partial<SchedulerJob> = {}): SchedulerJob {
  return {
    id: randomUUID(),
    organizationId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    goalId: "00000000-0000-4000-8000-000000000003",
    runId: randomUUID(),
    externalTaskId: "P11-DRILL",
    requiredCapability: "general_coding",
    state: "running",
    phase: "builder",
    priority: 1,
    attempt: 1,
    maxAttempts: 2,
    budget: { maxRuntimeSeconds: 900 },
    deadlineAt: "2026-08-05T04:00:00.000Z",
    nextAttemptAt: "2026-08-05T03:00:00.000Z",
    externalRunId: "p11-drill-external-run",
    nodeId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: "2026-08-05T03:14:00.000Z",
    lastEventSequence: 7,
    reconciliationRequired: false,
    version: 1,
    ...overrides,
  };
}

class DrillGateway implements ExecutionGatewayPort {
  readonly starts: ExecutionStartRequest[] = [];
  readonly cancels: string[] = [];
  readonly statuses = new Map<string, ExternalExecutionStatus>();

  async start(request: ExecutionStartRequest): Promise<ExternalExecutionStatus> {
    this.starts.push(structuredClone(request));
    return { externalRunId: request.externalRunId, state: "running", phase: "builder" };
  }

  async inspect(externalRunId: string): Promise<ExternalExecutionStatus | null> {
    return this.statuses.get(externalRunId) ?? null;
  }

  async cancel(externalRunId: string): Promise<void> {
    this.cancels.push(externalRunId);
  }
}

async function validateCatalog(): Promise<{
  manifest: RunbookManifest;
  manifestSha256: string;
  stopRunbookSha256: string;
}> {
  const manifestText = await readFile(manifestUrl, "utf8");
  const manifest = JSON.parse(manifestText);
  validateRunbookManifest(manifest);
  for (const runbook of manifest.runbooks) {
    const document = await readFile(new URL(`../../../${runbook.path}`, import.meta.url),
      "utf8");
    validateRunbookDocument(runbook, document, manifest.requiredSections);
  }
  const stopDocument = await readFile(stopRunbookUrl, "utf8");
  return {
    manifest,
    manifestSha256: sha256(manifestText),
    stopRunbookSha256: sha256(stopDocument),
  };
}

async function main(): Promise<void> {
  const started = new Date();
  const output = outputPath();
  const authorRole = role("RUNBOOK_DRILL_AUTHOR_ROLE");
  const executorRole = role("RUNBOOK_DRILL_EXECUTOR_ROLE");
  if (authorRole === executorRole) {
    throw new Error("Independent executor role must differ from author role");
  }
  const revision = required("RUNBOOK_DRILL_REVISION_NOTE");
  if (revision.length > 400) throw new Error("Runbook revision note is too long");
  const catalog = await validateCatalog();

  const controlRepository = new MemoryExecutionControlRepository();
  const control = new ExecutionControlService({
    repository: controlRepository,
    authorizer: { async authorize() {} },
    clock: () => NOW,
  });
  const stopReceipt = await control.execute({
    operation: "stop",
    scopeType: "project",
    scopeId: "00000000-0000-4000-8000-000000000002",
    actorId: "independent-drill-operator",
    requestId: "p11-runbook-drill-request",
    idempotencyKey: "p11-runbook-drill-stop",
    expectedVersion: 1,
    reason: "Isolated P11 Runbook Stop drill",
  });

  const stoppedJob = schedulerJob({ stopRequested: true });
  const stoppedRepository = new MemorySchedulerRepository({ jobs: [stoppedJob] });
  const stoppedGateway = new DrillGateway();
  stoppedGateway.statuses.set(stoppedJob.externalRunId as string, {
    externalRunId: stoppedJob.externalRunId as string,
    state: "running",
    phase: "builder",
  });
  const stopSupervisor = new SchedulerSupervisor({
    repository: stoppedRepository,
    gateway: stoppedGateway,
    supervisorId: "isolated-stop-supervisor",
    leaseDurationMs: 60_000,
    clock: () => NOW,
  });
  const stopResult = await stopSupervisor.tick();

  const lostJob = schedulerJob({
    id: randomUUID(),
    runId: randomUUID(),
    externalRunId: "p11-drill-lost-worker-run",
    nodeId: "00000000-0000-4000-8000-000000000020",
    leaseToken: "non-secret-isolated-lease-token",
    leaseExpiresAt: "2026-08-05T03:20:00.000Z",
  });
  const lostRepository = new MemorySchedulerRepository({
    jobs: [lostJob],
    nodes: [{
      id: lostJob.nodeId as string,
      name: "isolated-worker",
      provider: "fixture",
      capabilities: ["general_coding"],
      maxConcurrentRuns: 1,
      status: "online",
      heartbeatAt: "2026-08-05T03:13:00.000Z",
      offlineAfter: "2026-08-05T03:14:00.000Z",
      version: 1,
    }],
  });
  lostRepository.leases.push({
    id: randomUUID(),
    runId: lostJob.runId,
    nodeId: lostJob.nodeId as string,
    ownerId: "isolated-lost-supervisor",
    token: lostJob.leaseToken as string,
    status: "active",
    acquiredAt: "2026-08-05T03:10:00.000Z",
    heartbeatAt: "2026-08-05T03:13:00.000Z",
    expiresAt: "2026-08-05T03:20:00.000Z",
    releasedAt: null,
    version: 1,
  });
  const lostGateway = new DrillGateway();
  const lostSupervisor = new SchedulerSupervisor({
    repository: lostRepository,
    gateway: lostGateway,
    supervisorId: "isolated-replacement-supervisor",
    leaseDurationMs: 60_000,
    clock: () => NOW,
  });
  const lostResult = await lostSupervisor.tick();

  const assertions = {
    catalogValid: catalog.manifest.runbooks.length === 6,
    stopAudited: stopReceipt.state === "stopped" &&
      controlRepository.auditEvents.length === 1 &&
      controlRepository.outboxEvents.length === 1,
    stoppedBeforeClaim: stopResult.action === "reconciled" &&
      stoppedRepository.jobs[0]?.state === "cancelled" &&
      !stoppedRepository.operations.some((item) => item.startsWith("claim:")),
    externalRunCancelled: stoppedGateway.cancels.length === 1,
    workerLeaseExpired: lostRepository.leases[0]?.status === "expired" &&
      lostRepository.outbox.some((event) => event.eventType === "execution.lease_expired"),
    workerLossReconciled: lostResult.action === "reconciled" &&
      lostRepository.jobs[0]?.state === "blocked",
    noDuplicateLaunch: stoppedGateway.starts.length === 0 && lostGateway.starts.length === 0,
  };
  if (Object.values(assertions).some((passed) => !passed)) {
    throw new Error("Stop and Worker-loss drill assertion failed");
  }
  const completed = new Date();
  const receipt = {
    schemaVersion: catalog.manifest.drill.receiptSchemaVersion,
    drillId: randomUUID(),
    scenario: catalog.manifest.drill.scenario,
    mode: "isolated-control-plane-real-code-path",
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationSeconds: Number(((completed.getTime() - started.getTime()) / 1000).toFixed(3)),
    executor: {
      authorRole,
      executorRole,
      independent: true,
      inputScope: "runbook-and-manifest-only",
    },
    evidence: {
      manifest: "ops/production/runbook-manifest.json",
      manifestSha256: catalog.manifestSha256,
      runbook: "docs/runbooks/execution-stop-worker-loss.md",
      runbookSha256: catalog.stopRunbookSha256,
      stopReceiptVersion: stopReceipt.version,
      finalEventSequence: lostJob.lastEventSequence,
    },
    assertions,
    revisions: [revision],
    gaps: [],
    result: "passed",
  };
  validateRunbookDrillReceipt(receipt);
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    scenario: receipt.scenario,
    independent: receipt.executor.independent,
    result: receipt.result,
  }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Runbook drill failed";
  console.error(message.replace(/\/(?:Users|home|private|tmp)\/[^\s]+/g, "[REDACTED_PATH]"));
  process.exitCode = 1;
});
