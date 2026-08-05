import assert from "node:assert/strict";
import test from "node:test";

import {
  AlertEvaluator,
  P11_ALERT_RULES,
} from "../app/observability/alerting.ts";
import {
  PostgresOperationalSignalCollector,
  recordOperationalMetrics,
} from "../app/observability/operational-signals.ts";
import { StructuredTelemetry } from
  "../app/observability/telemetry.ts";

const healthy = {
  observedAt: "2026-08-05T12:00:00.000Z",
  schedulerTickAgeSeconds: 1,
  readyQueueDepth: 0,
  oldestReadyAgeSeconds: 0,
  queueDepth: 0,
  workerHeartbeatAgeSeconds: 1,
  offlineWorkerCount: 0,
  activeRunCount: 0,
  runFailureRate: 0,
  terminalRunSampleCount: 20,
  budgetUtilizationRatio: 0.1,
  budgetExceededCount: 0,
  databaseHealthy: true,
  objectStoreHealthy: true,
  sseFreshnessSeconds: 1,
  sseErrorRate: 0,
  suppressions: [],
};

const failing = {
  ...healthy,
  observedAt: "2026-08-05T12:00:00.000Z",
  schedulerTickAgeSeconds: 1_000,
  readyQueueDepth: 120,
  oldestReadyAgeSeconds: 900,
  queueDepth: 150,
  workerHeartbeatAgeSeconds: 300,
  offlineWorkerCount: 2,
  activeRunCount: 4,
  runFailureRate: 0.5,
  terminalRunSampleCount: 20,
  budgetUtilizationRatio: 0.95,
  budgetExceededCount: 1,
  databaseHealthy: false,
  objectStoreHealthy: false,
  sseFreshnessSeconds: 60,
  sseErrorRate: 0.3,
};

test("P11 alert catalog is actionable and covers every required failure surface", () => {
  assert.deepEqual(P11_ALERT_RULES.map((rule) => rule.id).sort(), [
    "budget_exhaustion",
    "database_unavailable",
    "object_store_unavailable",
    "queue_backlog",
    "run_failure_rate",
    "scheduler_stalled",
    "sse_stale",
    "worker_lost",
  ]);
  for (const rule of P11_ALERT_RULES) {
    assert.ok(rule.durationSeconds >= 0);
    assert.ok(rule.dedupeSeconds >= 300);
    assert.match(rule.owner, /^[a-z][a-z0-9-]+$/);
    assert.match(rule.runbook, /^docs\/runbooks\/alerts\.md#[a-z0-9-]+$/);
    assert.ok(["warning", "high", "critical"].includes(rule.severity));
    assert.ok(rule.summary.length >= 12);
  }
});

test("P11 synthetic failures fire once after their duration and all emit recovery", () => {
  const evaluator = new AlertEvaluator(P11_ALERT_RULES);
  assert.deepEqual(evaluator.evaluate(failing), [], "first breach only opens pending state");
  const fired = evaluator.evaluate({
    ...failing,
    observedAt: "2026-08-05T12:10:00.000Z",
  });
  assert.equal(fired.length, P11_ALERT_RULES.length);
  assert.ok(fired.every((transition) => transition.state === "firing"));
  assert.deepEqual(
    evaluator.evaluate({ ...failing, observedAt: "2026-08-05T12:11:00.000Z" }),
    [],
    "active alerts are deduplicated inside the notification window",
  );

  const recovered = evaluator.evaluate({
    ...healthy,
    observedAt: "2026-08-05T12:12:00.000Z",
  });
  assert.equal(recovered.length, P11_ALERT_RULES.length);
  assert.ok(recovered.every((transition) => transition.state === "resolved"));
});

test("P11 planned suppression prevents notification without hiding later real failure", () => {
  const evaluator = new AlertEvaluator(P11_ALERT_RULES);
  evaluator.evaluate({
    ...failing,
    suppressions: ["database_unavailable"],
  });
  const first = evaluator.evaluate({
    ...failing,
    observedAt: "2026-08-05T12:10:00.000Z",
    suppressions: ["database_unavailable"],
  });
  assert.equal(first.some((item) => item.ruleId === "database_unavailable"), false);
  const unsuppressed = evaluator.evaluate({
    ...failing,
    observedAt: "2026-08-05T12:11:00.000Z",
    suppressions: [],
  });
  assert.equal(unsuppressed.some((item) =>
    item.ruleId === "database_unavailable" && item.state === "firing"), true);
});

test("P11 PostgreSQL collector returns queue, worker, failure, budget, database, object and SSE signals", async () => {
  const calls = [];
  const collector = new PostgresOperationalSignalCollector({
    pool: {
      async query(sql, values) {
        calls.push({ sql, values });
        return { rows: [{
          scheduler_tick_age_seconds: 12,
          ready_queue_depth: 7,
          oldest_ready_age_seconds: 44,
          queue_depth: 9,
          worker_heartbeat_age_seconds: 18,
          offline_worker_count: 1,
          active_run_count: 2,
          run_failure_rate: 0.25,
          terminal_run_sample_count: 12,
          budget_utilization_ratio: 0.7,
          budget_exceeded_count: 0,
          sse_freshness_seconds: 3,
        }] };
      },
    },
    objectStoreProbe: { async check() { return true; } },
    sseErrorRate: () => 0.02,
    clock: () => new Date("2026-08-05T12:00:00.000Z"),
  });
  const signals = await collector.collect();
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /scheduler_jobs/);
  assert.match(calls[0].sql, /execution_nodes/);
  assert.match(calls[0].sql, /workbench_snapshots/);
  assert.equal(signals.databaseHealthy, true);
  assert.equal(signals.objectStoreHealthy, true);
  assert.equal(signals.readyQueueDepth, 7);
  assert.equal(signals.runFailureRate, 0.25);

  const entries = [];
  recordOperationalMetrics(
    new StructuredTelemetry({ sink: (entry) => entries.push(entry) }),
    signals,
  );
  assert.ok(entries.some((entry) => entry.metric?.name === "harness_queue_depth"));
  assert.ok(entries.some((entry) => entry.metric?.name === "harness_database_healthy"));
});

test("P11 collector fails closed into health signals without leaking database errors", async () => {
  const collector = new PostgresOperationalSignalCollector({
    pool: { async query() { throw new Error("postgresql://secret@db.invalid/harness"); } },
    objectStoreProbe: { async check() { throw new Error("object token=secret"); } },
    clock: () => new Date("2026-08-05T12:00:00.000Z"),
  });
  const signals = await collector.collect();
  assert.equal(signals.databaseHealthy, false);
  assert.equal(signals.objectStoreHealthy, false);
  assert.equal(JSON.stringify(signals).includes("secret"), false);
});
