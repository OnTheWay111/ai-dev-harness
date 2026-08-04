import pg from "pg";

import { AutoDevCliExecutionGateway } from
  "../app/control-plane/adapters/autodev-cli-execution-gateway.ts";
import { ArtifactIngestionExecutionSink } from
  "../app/control-plane/adapters/artifact-ingestion-execution-sink.ts";
import { AutoDevEventPoller } from
  "../app/control-plane/adapters/autodev-event-poller.ts";
import { PostgresExecutionEventRepository } from
  "../app/control-plane/adapters/postgres-execution-event-repository.ts";
import { PostgresEvidenceRepository } from
  "../app/control-plane/adapters/postgres-evidence-repository.ts";
import { PostgresSchedulerAdmissionRepository } from
  "../app/control-plane/adapters/postgres-scheduler-admission-repository.ts";
import { PostgresSchedulerAdmissionSource } from
  "../app/control-plane/adapters/postgres-scheduler-admission-source.ts";
import { PostgresSchedulerRepository } from
  "../app/control-plane/adapters/postgres-scheduler-repository.ts";
import { ExternalEventService } from
  "../app/control-plane/application/external-event-service.ts";
import { SchedulerAdmissionService } from
  "../app/control-plane/application/scheduler-admission-service.ts";
import { SchedulerSupervisor } from
  "../app/control-plane/application/scheduler-supervisor.ts";
import { ArtifactIngestionService } from
  "../app/control-plane/application/artifact-ingestion-service.ts";
import { getArtifactObjectStore } from
  "../app/control-plane/runtime/artifact-runtime.ts";
import { resolvePostgresConnection } from
  "../app/workbench/server/postgres-environment.ts";

const { Pool } = pg;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function stringArray(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return value;
}

function optionalPositiveNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function secretNames(): string[] {
  const names = (process.env.AUTODEV_EXECUTION_SECRET_NAMES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (names.some((name) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(name))) {
    throw new Error("AUTODEV_EXECUTION_SECRET_NAMES contains an invalid name");
  }
  return [...new Set(names)];
}

async function main(): Promise<void> {
  const database = resolvePostgresConnection(process.env, "app");
  const pool = new Pool({ connectionString: database.databaseUrl, max: 6 });
  const repository = new PostgresSchedulerRepository(pool);
  const admissionSource = new PostgresSchedulerAdmissionSource(pool);
  const admissionActorId = required("SCHEDULER_ADMISSION_ACTOR_ID");
  const admissionService = new SchedulerAdmissionService({
    repository: new PostgresSchedulerAdmissionRepository(pool),
    authorizer: {
      async authorize(command) {
        if (command.actorId !== admissionActorId) {
          throw new Error("Scheduler admission actor mismatch");
        }
      },
    },
  });
  const eventService = new ExternalEventService({
    repository: new PostgresExecutionEventRepository(pool),
  });
  const eventPoller = new AutoDevEventPoller({
    repositoryRoot: required("AUTODEV_REPOSITORY_ROOT"),
    service: eventService,
  });
  const selectedSecrets = secretNames();
  const gateway = new AutoDevCliExecutionGateway({
    pythonExecutable: required("AUTODEV_PYTHON"),
    projectConfigPath: required("AUTODEV_PROJECT_CONFIG"),
    networkWrapper: {
      executable: required("AUTODEV_NETWORK_WRAPPER"),
      arguments: stringArray("AUTODEV_NETWORK_WRAPPER_ARGS_JSON"),
    },
    environment: process.env,
    secretResolver: async (names) => Object.fromEntries(names.map((name) => {
      const value = process.env[name];
      if (!value) throw new Error(`Execution Secret ${name} is not injected`);
      return [name, value];
    })),
    artifactSink: new ArtifactIngestionExecutionSink(
      new ArtifactIngestionService({
        objectStore: getArtifactObjectStore(),
        repository: new PostgresEvidenceRepository(pool),
      }),
    ),
  });
  const intervalMs = positiveInteger("SCHEDULER_INTERVAL_MS", 2_000);
  const heartbeatMs = positiveInteger("EXECUTION_NODE_HEARTBEAT_MS", 15_000);
  const jobMaxAttempts = positiveInteger("SCHEDULER_JOB_MAX_ATTEMPTS", 3);
  const jobMaxRuntimeSeconds = positiveInteger(
    "SCHEDULER_JOB_MAX_RUNTIME_SECONDS",
    3600,
  );
  const admissionBatchSize = positiveInteger("SCHEDULER_ADMISSION_BATCH_SIZE", 10);
  if (admissionBatchSize > 100) {
    throw new Error("SCHEDULER_ADMISSION_BATCH_SIZE must not exceed 100");
  }
  const jobMaxCostUsd = optionalPositiveNumber("SCHEDULER_JOB_MAX_COST_USD");
  const nodeId = required("EXECUTION_NODE_ID");
  const supervisor = new SchedulerSupervisor({
    repository,
    gateway,
    supervisorId: required("SCHEDULER_SUPERVISOR_ID"),
    leaseDurationMs: positiveInteger("EXECUTION_LEASE_DURATION_MS", 60_000),
    selectedSecrets,
  });
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  try {
    while (!stopping) {
      const now = new Date();
      await repository.registerNode({
        id: nodeId,
        name: required("EXECUTION_NODE_NAME"),
        provider: process.env.EXECUTION_NODE_PROVIDER?.trim() || "local",
        capabilities: stringArray("EXECUTION_NODE_CAPABILITIES_JSON"),
        maxConcurrentRuns: positiveInteger("EXECUTION_NODE_CAPACITY", 1),
        now,
        offlineAfter: new Date(now.getTime() + heartbeatMs * 2),
      });
      const admissions = await admissionSource.listReady({
        actorId: admissionActorId,
        now,
        maxAttempts: jobMaxAttempts,
        maxRuntimeSeconds: jobMaxRuntimeSeconds,
        maxCostUsd: jobMaxCostUsd,
        limit: admissionBatchSize,
      });
      for (const command of admissions) await admissionService.admit(command);
      await supervisor.tick();
      for (const external of await repository.listExternalRuns()) {
        await eventPoller.poll(external);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Execution scheduler failed");
  process.exitCode = 1;
});
