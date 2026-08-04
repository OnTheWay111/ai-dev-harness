import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkbenchSnapshot,
  workbenchSemanticDigest,
} from "../app/workbench/projection/workbench-projection.ts";
import {
  MemoryWorkbenchProjectionPublisher,
  WorkbenchProjectionRunner,
} from "../app/workbench/projection/workbench-projection-runner.ts";

const scope = {
  scopeId: "test",
  organizationId: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000001",
};

function facts() {
  return {
    scope,
    goals: [{
      id: "30000000-0000-4000-8000-000000000001",
      title: "Production V1",
      status: "executing",
      version: 8,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-05T01:00:00.000Z",
    }],
    issues: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        goalId: "30000000-0000-4000-8000-000000000001",
        issueKey: "DEV-01",
        title: "Running issue",
        status: "in_progress",
        version: 4,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T01:30:00.000Z",
      },
      {
        id: "40000000-0000-4000-8000-000000000002",
        goalId: "30000000-0000-4000-8000-000000000001",
        issueKey: "DEV-02",
        title: "Blocked issue",
        status: "blocked",
        version: 3,
        createdAt: "2026-08-05T00:10:00.000Z",
        updatedAt: "2026-08-05T01:20:00.000Z",
      },
      {
        id: "40000000-0000-4000-8000-000000000003",
        goalId: "30000000-0000-4000-8000-000000000001",
        issueKey: "DEV-03",
        title: "Completed issue",
        status: "completed",
        version: 7,
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-05T01:10:00.000Z",
      },
    ],
    dependencies: [{
      issueId: "40000000-0000-4000-8000-000000000002",
      dependsOnIssueId: "40000000-0000-4000-8000-000000000001",
      dependsOnIssueKey: "DEV-01",
      satisfied: false,
      createdAt: "2026-08-05T00:10:00.000Z",
    }],
    runs: [
      {
        id: "50000000-0000-4000-8000-000000000001",
        issueId: "40000000-0000-4000-8000-000000000001",
        status: "running",
        version: 2,
        startedAt: "2026-08-05T01:00:00.000Z",
        finishedAt: null,
        updatedAt: "2026-08-05T01:30:00.000Z",
      },
      {
        id: "50000000-0000-4000-8000-000000000003",
        issueId: "40000000-0000-4000-8000-000000000003",
        status: "succeeded",
        version: 3,
        startedAt: "2026-08-05T00:00:00.000Z",
        finishedAt: "2026-08-05T01:10:00.000Z",
        updatedAt: "2026-08-05T01:10:00.000Z",
      },
    ],
    schedulerJobs: [
      {
        id: "60000000-0000-4000-8000-000000000001",
        issueId: "40000000-0000-4000-8000-000000000001",
        runId: "50000000-0000-4000-8000-000000000001",
        state: "running",
        phase: "builder",
        priority: 10,
        budget: { tokensUsed: 300, tokenLimit: 1000 },
        deadlineAt: "2026-08-05T04:00:00.000Z",
        nodeId: "70000000-0000-4000-8000-000000000001",
        failureCode: null,
        failureReason: null,
        version: 3,
        createdAt: "2026-08-05T00:50:00.000Z",
        updatedAt: "2026-08-05T01:30:00.000Z",
      },
      {
        id: "60000000-0000-4000-8000-000000000002",
        issueId: "40000000-0000-4000-8000-000000000002",
        runId: "50000000-0000-4000-8000-000000000002",
        state: "blocked",
        phase: "queued",
        priority: 50,
        budget: { conflictKeys: ["database:migrations"] },
        deadlineAt: "2026-08-05T03:00:00.000Z",
        nodeId: null,
        failureCode: "resource_conflict",
        failureReason: "database:migrations is held by DEV-01",
        version: 2,
        createdAt: "2026-08-05T00:10:00.000Z",
        updatedAt: "2026-08-05T01:20:00.000Z",
      },
    ],
    nodes: [
      {
        id: "70000000-0000-4000-8000-000000000001",
        name: "node-a",
        status: "online",
        maxConcurrentRuns: 2,
        offlineAfter: "2026-08-05T02:05:00.000Z",
        updatedAt: "2026-08-05T02:00:00.000Z",
      },
      {
        id: "70000000-0000-4000-8000-000000000002",
        name: "node-b",
        status: "offline",
        maxConcurrentRuns: 4,
        offlineAfter: "2026-08-05T01:00:00.000Z",
        updatedAt: "2026-08-05T00:55:00.000Z",
      },
    ],
    leases: [{
      runId: "50000000-0000-4000-8000-000000000001",
      nodeId: "70000000-0000-4000-8000-000000000001",
      status: "active",
      expiresAt: "2026-08-05T02:05:00.000Z",
      heartbeatAt: "2026-08-05T02:00:00.000Z",
    }],
    controls: [{
      scopeType: "project",
      state: "active",
      circuitOpenUntil: null,
      updatedAt: "2026-08-05T01:00:00.000Z",
    }],
    evidenceCounts: [{
      issueId: "40000000-0000-4000-8000-000000000001",
      count: 4,
      updatedAt: "2026-08-05T01:45:00.000Z",
    }],
  };
}

test("builds all six metrics and ordered tasks only from authoritative facts", async () => {
  const snapshot = buildWorkbenchSnapshot(facts(), {
    revision: 9,
    generatedAt: "2026-08-05T02:00:00.000Z",
  });

  assert.equal(snapshot.summary.metrics.length, 6);
  assert.deepEqual(
    Object.fromEntries(snapshot.summary.metrics.map((metric) => [metric.id, `${metric.value}${metric.suffix ?? ""}`])),
    {
      attention: "1",
      running: "1",
      active_workers: "1/2",
      blocked: "1",
      completed_today: "1",
      budget_health: "健康",
    },
  );
  assert.deepEqual(snapshot.summary.taskCounts, {
    all: 2,
    attention: 1,
    running: 1,
    review: 0,
    blocked: 1,
    waiting: 0,
  });
  assert.deepEqual(
    snapshot.tasks.map((task) => task.id.split(":").at(-1)),
    ["DEV-02", "DEV-01"],
  );
  assert.equal(snapshot.tasks[0].attention.severity, "blocking");
  assert.match(snapshot.tasks[0].attention.rankingReason, /截止|阻塞|等待/);
  assert.match(snapshot.tasks[0].detail.dependency, /DEV-01/);
  assert.match(snapshot.tasks[0].detail.workspace, /未分配/);
  assert.equal(snapshot.tasks[1].execution.actorId, "node-a");
  assert.equal(snapshot.tasks[1].version, 9);
  assert.match(snapshot.tasks[1].detail.evidence, /4/);
});

test("uses stable fallbacks, boundary-safe capacity, and deterministic semantic digests", async () => {
  const input = facts();
  input.schedulerJobs[0].budget = { tokensUsed: 850, tokenLimit: 1000 };
  input.nodes[0].maxConcurrentRuns = 1;
  const first = buildWorkbenchSnapshot(input, {
    revision: 10,
    generatedAt: "2026-08-05T02:00:00.000Z",
  });
  const second = buildWorkbenchSnapshot(structuredClone(input), {
    revision: 11,
    generatedAt: "2026-08-05T02:00:00.000Z",
  });

  assert.equal(first.summary.metrics.find((metric) => metric.id === "budget_health").value, "告警");
  assert.equal(first.summary.metrics.find((metric) => metric.id === "active_workers").suffix, "/1");
  assert.equal(await workbenchSemanticDigest(first), await workbenchSemanticDigest(second));

  const changedParticipant = structuredClone(input);
  changedParticipant.schedulerJobs[0].version += 1;
  const changed = buildWorkbenchSnapshot(changedParticipant, {
    revision: 12,
    generatedAt: "2026-08-05T02:00:00.000Z",
  });
  assert.equal(
    changed.tasks.find((task) => task.id.endsWith(":DEV-01")).version,
    first.tasks.find((task) => task.id.endsWith(":DEV-01")).version + 1,
  );
});

test("deduplicates repeated triggers, makes replay equivalent, serializes a scope, and preserves the last projection on failure", async () => {
  let cursor = { occurredAt: "2026-08-05T02:00:00.000Z", eventId: "80000000-0000-4000-8000-000000000001" };
  const publisher = new MemoryWorkbenchProjectionPublisher();
  const source = {
    async listScopes() { return [scope]; },
    async latestTrigger() { return cursor; },
    async loadFacts() { return facts(); },
  };
  const runner = new WorkbenchProjectionRunner({
    source,
    publisher,
    clock: () => new Date("2026-08-05T02:00:00.000Z"),
  });

  await Promise.all([runner.projectScope(scope), runner.projectScope(scope)]);
  assert.equal(publisher.get(scope).revision, 1);

  cursor = { occurredAt: "2026-08-05T02:01:00.000Z", eventId: "80000000-0000-4000-8000-000000000002" };
  await runner.runOnce();
  assert.equal(publisher.get(scope).revision, 1, "same facts only advance the trigger checkpoint");

  const beforeReplay = publisher.get(scope).snapshot;
  await runner.replay(scope);
  assert.equal(publisher.get(scope).revision, 1);
  assert.equal(
    await workbenchSemanticDigest(beforeReplay),
    await workbenchSemanticDigest(publisher.get(scope).snapshot),
  );

  const failing = new WorkbenchProjectionRunner({
    source: { ...source, async loadFacts() { throw new Error("fact source unavailable"); } },
    publisher,
  });
  await assert.rejects(() => failing.replay(scope), /fact source unavailable/);
  assert.equal(publisher.get(scope).revision, 1);
});
