import assert from "node:assert/strict";
import test from "node:test";

import { AutoDevCliExecutionGateway } from
  "../app/control-plane/adapters/autodev-cli-execution-gateway.ts";
import { MemoryExecutionEventRepository } from
  "../app/control-plane/adapters/memory-execution-event-repository.ts";
import { MemorySchedulerRepository } from
  "../app/control-plane/adapters/memory-scheduler-repository.ts";
import {
  ExternalEventService,
  normalizeAutoDevRunEvent,
} from "../app/control-plane/application/external-event-service.ts";
import { SchedulerSupervisor } from
  "../app/control-plane/application/scheduler-supervisor.ts";
import {
  createObservabilityContext,
  observabilityEnvironment,
  propagateRequestHeaders,
} from "../app/observability/context.ts";
import { StructuredTelemetry } from
  "../app/observability/telemetry.ts";

const ids = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
  issueId: "00000000-0000-4000-8000-000000000004",
  runId: "00000000-0000-4000-8000-000000000005",
};

test("P11 web propagation accepts valid correlation headers and replaces unsafe values", () => {
  const incoming = new Headers({
    "x-request-id": "request-web-42",
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  });
  const propagated = propagateRequestHeaders(incoming);
  assert.equal(propagated.requestId, "request-web-42");
  assert.equal(propagated.traceId, "0123456789abcdef0123456789abcdef");
  assert.equal(propagated.headers.get("x-request-id"), "request-web-42");
  assert.match(propagated.headers.get("traceparent"),
    /^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/);

  const unsafe = propagateRequestHeaders(new Headers({
    "x-request-id": "bad request forged",
    traceparent: "00-not-a-trace-not-a-span-01",
  }));
  assert.match(unsafe.requestId, /^req_[0-9a-f-]{36}$/);
  assert.match(unsafe.traceId, /^[0-9a-f]{32}$/);
});

test("P11 structured logs and metrics retain correlation but redact secrets and identities", () => {
  const entries = [];
  const telemetry = new StructuredTelemetry({ sink: (entry) => entries.push(entry) });
  const context = createObservabilityContext({
    process: "web",
    requestId: "request-redaction",
    goalId: ids.goalId,
    receiptId: "rcpt_00000000-0000-4000-8000-000000000006",
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
  });
  telemetry.event("task.action.accepted", context, {
    authorization: "Bearer should-never-appear",
    databaseUrl: "postgresql://user:password@db.invalid/control",
    actorEmail: "operator@example.com",
    result: "accepted",
  });
  telemetry.metric("harness_http_request_duration_ms", "histogram", 12, {
    route: "/api/v1/tasks/:taskId/actions",
    status: "202",
  });

  const serialized = JSON.stringify(entries);
  assert.match(serialized, /request-redaction/);
  assert.match(serialized, /task\.action\.accepted/);
  assert.doesNotMatch(serialized, /should-never-appear|user:password|operator@example\.com/);
  assert.match(serialized, /\[REDACTED/);
  assert.equal(entries[1].metric.name, "harness_http_request_duration_ms");
});

test("P11 scheduler passes request goal issue run and trace context into the Gateway process", async () => {
  const job = {
    id: "00000000-0000-4000-8000-000000000010",
    ...ids,
    requestId: "request-scheduler-42",
    externalTaskId: "H-1101",
    requiredCapability: "general_coding",
    state: "pending",
    phase: "queued",
    priority: 1,
    attempt: 1,
    maxAttempts: 2,
    budget: { maxRuntimeSeconds: 60 },
    deadlineAt: "2026-08-05T12:30:00.000Z",
    nextAttemptAt: "2026-08-05T12:00:00.000Z",
    externalRunId: null,
    nodeId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    lastEventSequence: 0,
    reconciliationRequired: false,
    version: 1,
  };
  const repository = new MemorySchedulerRepository({
    jobs: [job],
    nodes: [{
      id: "00000000-0000-4000-8000-000000000020",
      name: "p11-node",
      provider: "local",
      capabilities: ["general_coding"],
      maxConcurrentRuns: 1,
      status: "online",
      heartbeatAt: "2026-08-05T12:00:00.000Z",
      offlineAfter: "2026-08-05T12:10:00.000Z",
      version: 1,
    }],
  });
  const starts = [];
  const gateway = {
    async start(request) {
      starts.push(structuredClone(request));
      return { externalRunId: request.externalRunId, state: "running", phase: "builder" };
    },
    async inspect() { return null; },
    async cancel() {},
  };
  const telemetryEntries = [];
  const supervisor = new SchedulerSupervisor({
    repository,
    gateway,
    supervisorId: "scheduler-p11",
    clock: () => new Date("2026-08-05T12:00:00.000Z"),
    leaseDurationMs: 60_000,
    telemetry: new StructuredTelemetry({ sink: (entry) => telemetryEntries.push(entry) }),
  });
  await supervisor.tick();
  assert.equal(starts.length, 1);
  assert.deepEqual(
    Object.fromEntries(Object.entries(starts[0].observability)
      .filter(([key]) => ["requestId", "goalId", "issueId", "runId"].includes(key))),
    {
      requestId: job.requestId,
      goalId: ids.goalId,
      issueId: ids.issueId,
      runId: ids.runId,
    },
  );
  assert.match(starts[0].observability.traceId, /^[0-9a-f]{32}$/);
  assert.ok(telemetryEntries.some((entry) => entry.event === "scheduler.run.started"));
});

test("P11 Gateway exposes only the versioned observability envelope plus selected secrets", async () => {
  const calls = [];
  const context = createObservabilityContext({
    process: "gateway",
    requestId: "request-gateway-42",
    ...ids,
    traceId: "3".repeat(32),
    spanId: "4".repeat(16),
  });
  const gateway = new AutoDevCliExecutionGateway({
    pythonExecutable: "/usr/bin/python3",
    projectConfigPath: "/srv/autodev/project.yaml",
    trustedRunnerEnforcesNetwork: true,
    environment: { PATH: "/usr/bin", SHOULD_NOT_LEAK: "private" },
    secretResolver: async () => ({ AUTODEV_API_TOKEN: "p11-secret-value" }),
    processRunner: async (request) => {
      calls.push(request);
      return { exitCode: 0, stdout: '{"status":"done"}', stderr: "" };
    },
  });
  await gateway.start({
    externalTaskId: "H-1101",
    externalRunId: "p11-run-a1",
    selectedSecrets: ["AUTODEV_API_TOKEN"],
    timeoutMs: 10_000,
    observability: context,
  });
  assert.deepEqual(Object.keys(calls[0].environment).sort(), [
    "AUTODEV_API_TOKEN", "HARNESS_OBSERVABILITY_CONTEXT", "PATH",
  ]);
  assert.deepEqual(
    JSON.parse(calls[0].environment.HARNESS_OBSERVABILITY_CONTEXT),
    observabilityEnvironment(context),
  );
  assert.doesNotMatch(calls[0].environment.HARNESS_OBSERVABILITY_CONTEXT, /p11-secret-value/);
});

test("P11 AutoDev event correlation survives Worker normalization and rejects identity substitution", async () => {
  const eventContext = createObservabilityContext({
    process: "worker",
    requestId: "request-worker-42",
    ...ids,
    traceId: "5".repeat(32),
    spanId: "6".repeat(16),
  });
  const raw = {
    schema_version: "autodev.run-event.v1",
    event_id: "p11-worker-event-1",
    sequence: 1,
    timestamp: "2026-08-05T12:00:01.000Z",
    phase: "builder",
    level: "info",
    task_id: "H-1101",
    message: "builder started",
    observability: observabilityEnvironment(eventContext),
  };
  const event = normalizeAutoDevRunEvent(raw, "p11-external-a1");
  assert.equal(event.observability?.traceId, eventContext.traceId);
  assert.equal(event.observability?.runId, ids.runId);

  const repository = new MemoryExecutionEventRepository([{
    id: ids.runId,
    ...ids,
    externalRunId: "p11-external-a1",
    externalTaskId: "H-1101",
    status: "queued",
    phase: "queued",
    version: 1,
    lastEventSequence: 0,
    reconciliationRequired: false,
  }]);
  const service = new ExternalEventService({ repository });
  assert.equal((await service.ingest(event)).disposition, "applied");
  await assert.rejects(
    () => service.ingest({
      ...event,
      sourceEventId: "p11-worker-event-2",
      sequence: 2,
      observability: { ...event.observability, goalId: crypto.randomUUID() },
    }),
    /does not own/i,
  );
});
