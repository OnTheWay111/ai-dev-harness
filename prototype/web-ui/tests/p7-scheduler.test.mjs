import assert from "node:assert/strict";
import test from "node:test";

import { MemorySchedulerRepository } from
  "../app/control-plane/adapters/memory-scheduler-repository.ts";
import { SchedulerSupervisor } from
  "../app/control-plane/application/scheduler-supervisor.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
};

function job(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    ...scope,
    runId: "00000000-0000-4000-8000-000000000011",
    externalTaskId: "H-001",
    requiredCapability: "general_coding",
    state: "pending",
    phase: "queued",
    priority: 10,
    attempt: 1,
    maxAttempts: 2,
    budget: { maxRuntimeSeconds: 900 },
    deadlineAt: "2026-08-04T12:30:00.000Z",
    nextAttemptAt: "2026-08-04T12:00:00.000Z",
    externalRunId: null,
    nodeId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    lastEventSequence: 0,
    reconciliationRequired: false,
    version: 1,
    ...overrides,
  };
}

function node(id, maxConcurrentRuns = 1) {
  return {
    id,
    name: id,
    provider: "local",
    capabilities: ["general_coding"],
    maxConcurrentRuns,
    status: "online",
    heartbeatAt: "2026-08-04T12:00:00.000Z",
    offlineAfter: "2026-08-04T12:10:00.000Z",
    version: 1,
  };
}

class FakeGateway {
  starts = [];
  cancels = [];
  statuses = new Map();

  async start(request) {
    this.starts.push(structuredClone(request));
    this.statuses.set(request.externalRunId, {
      externalRunId: request.externalRunId,
      state: "running",
      phase: "builder",
    });
    return this.statuses.get(request.externalRunId);
  }

  async inspect(externalRunId) {
    return this.statuses.get(externalRunId) ?? null;
  }

  async cancel(externalRunId) {
    this.cancels.push(externalRunId);
    this.statuses.set(externalRunId, {
      externalRunId,
      state: "cancelled",
      phase: "cancelled",
    });
  }
}

test("P7 supervisor reconciles before claiming and starts exactly once", async () => {
  const repository = new MemorySchedulerRepository({
    jobs: [job()],
    nodes: [node("00000000-0000-4000-8000-000000000020")],
  });
  const gateway = new FakeGateway();
  const supervisor = new SchedulerSupervisor({
    repository,
    gateway,
    supervisorId: "scheduler-a",
    clock: () => new Date("2026-08-04T12:00:00.000Z"),
    leaseDurationMs: 60_000,
  });

  const result = await supervisor.tick();
  assert.equal(result.action, "started");
  assert.equal(repository.operations[0], "reconcile:list");
  assert.equal(gateway.starts.length, 1);
  assert.equal(repository.jobs[0].state, "running");
  assert.equal(repository.activeLeases.length, 1);

  await supervisor.tick();
  assert.equal(gateway.starts.length, 1, "an active run is never launched twice");
});

test("P7 runtime budget caps the external process timeout before the deadline", async () => {
  const repository = new MemorySchedulerRepository({
    jobs: [job({ budget: { maxRuntimeSeconds: 30 } })],
    nodes: [node("00000000-0000-4000-8000-000000000020")],
  });
  const gateway = new FakeGateway();
  const supervisor = new SchedulerSupervisor({
    repository,
    gateway,
    supervisorId: "scheduler-a",
    clock: () => new Date("2026-08-04T12:00:00.000Z"),
    leaseDurationMs: 60_000,
  });

  await supervisor.tick();
  assert.equal(gateway.starts[0].timeoutMs, 30_000);
});

test("P7 restart reconciles an externally started run instead of duplicating it", async () => {
  const repository = new MemorySchedulerRepository({
    jobs: [job()],
    nodes: [node("00000000-0000-4000-8000-000000000020")],
  });
  const gateway = new FakeGateway();
  const crashing = new SchedulerSupervisor({
    repository,
    gateway,
    supervisorId: "scheduler-a",
    clock: () => new Date("2026-08-04T12:00:00.000Z"),
    leaseDurationMs: 60_000,
    afterExternalStart: () => { throw new Error("crash after external start"); },
  });
  await assert.rejects(() => crashing.tick(), /crash after external start/);
  assert.equal(repository.jobs[0].state, "starting");
  assert.equal(repository.jobs[0].reconciliationRequired, true);

  const restarted = new SchedulerSupervisor({
    repository,
    gateway,
    supervisorId: "scheduler-b",
    clock: () => new Date("2026-08-04T12:00:30.000Z"),
    leaseDurationMs: 60_000,
  });
  const result = await restarted.tick();
  assert.equal(result.action, "reconciled");
  assert.equal(repository.jobs[0].state, "running");
  assert.equal(repository.jobs[0].reconciliationRequired, false);
  assert.equal(gateway.starts.length, 1);
});

test("P7 leases enforce node capacity and one active owner per Run", async () => {
  const repository = new MemorySchedulerRepository({
    jobs: [job()],
    nodes: [
      node("00000000-0000-4000-8000-000000000020"),
      node("00000000-0000-4000-8000-000000000021"),
    ],
  });
  const first = await repository.acquireLease({
    runId: repository.jobs[0].runId,
    nodeId: repository.nodes[0].id,
    ownerId: "scheduler-a",
    now: new Date("2026-08-04T12:00:00.000Z"),
    expiresAt: new Date("2026-08-04T12:01:00.000Z"),
  });
  const replay = await repository.acquireLease({
    runId: repository.jobs[0].runId,
    nodeId: repository.nodes[0].id,
    ownerId: "scheduler-a",
    now: new Date("2026-08-04T12:00:10.000Z"),
    expiresAt: new Date("2026-08-04T12:01:10.000Z"),
  });
  const competing = await repository.acquireLease({
    runId: repository.jobs[0].runId,
    nodeId: repository.nodes[1].id,
    ownerId: "scheduler-b",
    now: new Date("2026-08-04T12:00:10.000Z"),
    expiresAt: new Date("2026-08-04T12:01:10.000Z"),
  });
  assert.equal(replay?.token, first?.token);
  assert.equal(competing, null);
  assert.equal(repository.activeLeases.length, 1);
});

test("P7 node selection never silently downgrades the required capability", async () => {
  const repository = new MemorySchedulerRepository({
    jobs: [job({ requiredCapability: "advanced_coding" })],
    nodes: [
      node("00000000-0000-4000-8000-000000000020"),
      {
        ...node("00000000-0000-4000-8000-000000000021"),
        capabilities: ["advanced_coding"],
      },
    ],
  });

  assert.equal(
    (await repository.selectNode(repository.jobs[0], new Date("2026-08-04T12:00:00Z")))?.id,
    repository.nodes[1].id,
  );
  assert.equal(await repository.acquireLease({
    runId: repository.jobs[0].runId,
    nodeId: repository.nodes[0].id,
    ownerId: "scheduler-a",
    now: new Date("2026-08-04T12:00:00Z"),
    expiresAt: new Date("2026-08-04T12:01:00Z"),
  }), null, "the lease transaction must recheck capability");
});

test("P7 deadline reconciliation cancels a timed-out external process", async () => {
  const active = job({
    state: "running",
    phase: "builder",
    externalRunId: "cp-00000000-0000-4000-8000-000000000011-a1",
    reconciliationRequired: true,
    deadlineAt: "2026-08-04T11:59:00.000Z",
  });
  const repository = new MemorySchedulerRepository({ jobs: [active], nodes: [] });
  const gateway = new FakeGateway();
  gateway.statuses.set(active.externalRunId, {
    externalRunId: active.externalRunId,
    state: "running",
    phase: "builder",
  });
  const supervisor = new SchedulerSupervisor({
    repository,
    gateway,
    supervisorId: "scheduler-a",
    clock: () => new Date("2026-08-04T12:00:00.000Z"),
    leaseDurationMs: 60_000,
  });
  await supervisor.tick();
  assert.deepEqual(gateway.cancels, [active.externalRunId]);
  assert.equal(repository.jobs[0].state, "failed");
  assert.equal(repository.jobs[0].failureCode, "deadline_exceeded");
});

test("P7 project or global stop cancels an active external process before more work", async () => {
  const active = job({
    state: "running",
    phase: "builder",
    externalRunId: "cp-stopped-a1",
    stopRequested: true,
  });
  const repository = new MemorySchedulerRepository({ jobs: [active], nodes: [] });
  const gateway = new FakeGateway();
  gateway.statuses.set(active.externalRunId, {
    externalRunId: active.externalRunId,
    state: "running",
    phase: "builder",
  });
  const supervisor = new SchedulerSupervisor({
    repository,
    gateway,
    supervisorId: "scheduler-a",
    clock: () => new Date("2026-08-04T12:00:00.000Z"),
    leaseDurationMs: 60_000,
  });

  assert.equal((await supervisor.tick()).action, "reconciled");
  assert.deepEqual(gateway.cancels, [active.externalRunId]);
  assert.equal(repository.jobs[0].state, "cancelled");
  assert.equal(repository.jobs[0].failureCode, "operator_stop");
  assert.equal(repository.operations.includes("claim:scheduler-a"), false);
});

test("P7 offline nodes immediately expire owned leases and force reconciliation", async () => {
  const active = job({ state: "running", externalRunId: "cp-offline-a1" });
  const repository = new MemorySchedulerRepository({
    jobs: [active],
    nodes: [{
      ...node("00000000-0000-4000-8000-000000000020"),
      offlineAfter: "2026-08-04T11:59:59.000Z",
    }],
  });
  repository.leases.push({
    id: "00000000-0000-4000-8000-000000000030",
    runId: active.runId,
    nodeId: repository.nodes[0].id,
    ownerId: "scheduler-a",
    token: "lease-token",
    status: "active",
    acquiredAt: "2026-08-04T11:59:00.000Z",
    heartbeatAt: "2026-08-04T11:59:30.000Z",
    expiresAt: "2026-08-04T12:05:00.000Z",
    releasedAt: null,
    version: 1,
  });

  const jobs = await repository.listForReconciliation(
    new Date("2026-08-04T12:00:00.000Z"),
  );
  assert.equal(repository.nodes[0].status, "offline");
  assert.equal(repository.leases[0].status, "expired");
  assert.deepEqual(jobs.map((candidate) => candidate.id), [active.id]);
  assert.equal(repository.outbox.at(-1)?.eventType, "execution.lease_expired");
});

test("P7 gateway failure releases the lease and retries with a new attempt id", async () => {
  const repository = new MemorySchedulerRepository({
    jobs: [job()],
    nodes: [node("00000000-0000-4000-8000-000000000020")],
  });
  const gateway = new FakeGateway();
  const originalStart = gateway.start.bind(gateway);
  let fail = true;
  gateway.start = async (request) => {
    if (fail) {
      fail = false;
      gateway.starts.push(structuredClone(request));
      throw new Error("CLI unavailable");
    }
    return await originalStart(request);
  };
  let now = new Date("2026-08-04T12:00:00.000Z");
  const supervisor = new SchedulerSupervisor({
    repository,
    gateway,
    supervisorId: "scheduler-a",
    clock: () => now,
    leaseDurationMs: 60_000,
  });
  assert.equal((await supervisor.tick()).action, "retry_scheduled");
  assert.equal(repository.jobs[0].state, "retry_wait");
  assert.equal(repository.jobs[0].attempt, 2);
  assert.equal(repository.activeLeases.length, 0);

  now = new Date("2026-08-04T12:00:03.000Z");
  assert.equal((await supervisor.tick()).action, "started");
  assert.deepEqual(
    gateway.starts.map((request) => request.externalRunId),
    [
      `cp-${repository.jobs[0].runId}-a1`,
      `cp-${repository.jobs[0].runId}-a2`,
    ],
  );
});

test("P7 landing interruption blocks for reconciliation without launching again", async () => {
  const active = job({
    state: "running",
    phase: "landing",
    externalRunId: "cp-landing-a1",
    reconciliationRequired: true,
  });
  const repository = new MemorySchedulerRepository({ jobs: [active], nodes: [] });
  const gateway = new FakeGateway();
  const supervisor = new SchedulerSupervisor({
    repository,
    gateway,
    supervisorId: "scheduler-after-crash",
    clock: () => new Date("2026-08-04T12:00:00.000Z"),
    leaseDurationMs: 60_000,
  });
  assert.equal((await supervisor.tick()).action, "reconciled");
  assert.equal(repository.jobs[0].state, "blocked");
  assert.equal(repository.jobs[0].failureCode, "external_state_unknown");
  assert.equal(gateway.starts.length, 0);
});
