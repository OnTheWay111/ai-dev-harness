import type { PostgresPool } from
  "../control-plane/adapters/postgres-goal-repository.ts";
import type { OperationalTelemetry } from "./telemetry.ts";
import type { OperationalSignals } from "./alerting.ts";

interface SignalRow {
  scheduler_tick_age_seconds: number | string | null;
  ready_queue_depth: number | string | null;
  oldest_ready_age_seconds: number | string | null;
  queue_depth: number | string | null;
  worker_heartbeat_age_seconds: number | string | null;
  offline_worker_count: number | string | null;
  active_run_count: number | string | null;
  run_failure_rate: number | string | null;
  terminal_run_sample_count: number | string | null;
  budget_utilization_ratio: number | string | null;
  budget_exceeded_count: number | string | null;
  sse_freshness_seconds: number | string | null;
}

export interface ObjectStoreProbe {
  check(): Promise<boolean>;
}

function numeric(value: number | string | null | undefined, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}

const SIGNAL_QUERY = `
WITH job_signals AS (
  SELECT
    COUNT(*) FILTER (WHERE state IN ('pending','retry_wait')
      AND next_attempt_at <= now())::int AS ready_queue_depth,
    COUNT(*) FILTER (WHERE state NOT IN
      ('succeeded','failed','cancelled','blocked'))::int AS queue_depth,
    COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)) FILTER
      (WHERE state IN ('pending','retry_wait') AND next_attempt_at <= now()), 0)
      AS oldest_ready_age_seconds,
    COUNT(*) FILTER (WHERE state IN
      ('claimed','starting','running','reconciling'))::int AS active_run_count,
    COALESCE(MAX(
      CASE WHEN (budget->>'tokenLimit')::numeric > 0
        THEN (budget->>'tokensUsed')::numeric / (budget->>'tokenLimit')::numeric
        ELSE 0 END
    ), 0) AS budget_utilization_ratio,
    COUNT(*) FILTER (WHERE
      COALESCE((budget->>'tokensUsed')::numeric, 0) >
      COALESCE(NULLIF((budget->>'tokenLimit')::numeric, 0), 1))::int
      AS budget_exceeded_count
  FROM scheduler_jobs
), node_signals AS (
  SELECT
    COALESCE(EXTRACT(EPOCH FROM now() - MAX(heartbeat_at)), 0)
      AS worker_heartbeat_age_seconds,
    COUNT(*) FILTER (WHERE status='offline' OR offline_after <= now())::int
      AS offline_worker_count
  FROM execution_nodes
), run_signals AS (
  SELECT
    COALESCE(COUNT(*) FILTER (WHERE status='failed')::numeric /
      NULLIF(COUNT(*) FILTER (WHERE status IN
        ('succeeded','failed','cancelled')), 0), 0) AS run_failure_rate,
    COUNT(*) FILTER (WHERE status IN
      ('succeeded','failed','cancelled'))::int AS terminal_run_sample_count
  FROM runs
  WHERE updated_at >= now() - interval '15 minutes'
), projection_signals AS (
  SELECT COALESCE(EXTRACT(EPOCH FROM now() - MAX(generated_at)), 0)
    AS sse_freshness_seconds
  FROM workbench_snapshots
), scheduler_signals AS (
  SELECT COALESCE(EXTRACT(EPOCH FROM now() - MAX(updated_at)), 0)
    AS scheduler_tick_age_seconds
  FROM scheduler_jobs
)
SELECT * FROM job_signals, node_signals, run_signals,
  projection_signals, scheduler_signals`;

const emptySignals = (observedAt: string): OperationalSignals => ({
  observedAt,
  schedulerTickAgeSeconds: 0,
  readyQueueDepth: 0,
  oldestReadyAgeSeconds: 0,
  queueDepth: 0,
  workerHeartbeatAgeSeconds: 0,
  offlineWorkerCount: 0,
  activeRunCount: 0,
  runFailureRate: 0,
  terminalRunSampleCount: 0,
  budgetUtilizationRatio: 0,
  budgetExceededCount: 0,
  databaseHealthy: false,
  objectStoreHealthy: false,
  sseFreshnessSeconds: 0,
  sseErrorRate: 0,
  suppressions: [],
});

export class PostgresOperationalSignalCollector {
  private readonly pool: PostgresPool;
  private readonly objectStoreProbe: ObjectStoreProbe;
  private readonly sseErrorRate: () => number;
  private readonly suppressions: () => readonly string[];
  private readonly clock: () => Date;

  constructor(input: {
    pool: PostgresPool;
    objectStoreProbe: ObjectStoreProbe;
    sseErrorRate?: () => number;
    suppressions?: () => readonly string[];
    clock?: () => Date;
  }) {
    this.pool = input.pool;
    this.objectStoreProbe = input.objectStoreProbe;
    this.sseErrorRate = input.sseErrorRate ?? (() => 0);
    this.suppressions = input.suppressions ?? (() => []);
    this.clock = input.clock ?? (() => new Date());
  }

  async collect(): Promise<OperationalSignals> {
    const signals = emptySignals(this.clock().toISOString());
    try {
      const result = await this.pool.query<SignalRow>(SIGNAL_QUERY, []);
      const row = result.rows[0];
      if (!row) return signals;
      Object.assign(signals, {
        schedulerTickAgeSeconds: numeric(row.scheduler_tick_age_seconds),
        readyQueueDepth: numeric(row.ready_queue_depth),
        oldestReadyAgeSeconds: numeric(row.oldest_ready_age_seconds),
        queueDepth: numeric(row.queue_depth),
        workerHeartbeatAgeSeconds: numeric(row.worker_heartbeat_age_seconds),
        offlineWorkerCount: numeric(row.offline_worker_count),
        activeRunCount: numeric(row.active_run_count),
        runFailureRate: numeric(row.run_failure_rate),
        terminalRunSampleCount: numeric(row.terminal_run_sample_count),
        budgetUtilizationRatio: numeric(row.budget_utilization_ratio),
        budgetExceededCount: numeric(row.budget_exceeded_count),
        sseFreshnessSeconds: numeric(row.sse_freshness_seconds),
        databaseHealthy: true,
      });
    } catch {
      // Health signals deliberately contain no exception details or connection strings.
    }
    try {
      signals.objectStoreHealthy = await this.objectStoreProbe.check();
    } catch {
      signals.objectStoreHealthy = false;
    }
    signals.sseErrorRate = numeric(this.sseErrorRate());
    signals.suppressions = this.suppressions()
      .filter((item) => /^[a-z][a-z0-9_]{2,63}$/.test(item));
    return signals;
  }
}

export function recordOperationalMetrics(
  telemetry: OperationalTelemetry,
  signals: OperationalSignals,
): void {
  const gauges: Readonly<Record<string, number>> = {
    harness_scheduler_tick_age_seconds: signals.schedulerTickAgeSeconds,
    harness_ready_queue_depth: signals.readyQueueDepth,
    harness_oldest_ready_age_seconds: signals.oldestReadyAgeSeconds,
    harness_queue_depth: signals.queueDepth,
    harness_worker_heartbeat_age_seconds: signals.workerHeartbeatAgeSeconds,
    harness_offline_worker_count: signals.offlineWorkerCount,
    harness_active_run_count: signals.activeRunCount,
    harness_run_failure_rate: signals.runFailureRate,
    harness_terminal_run_sample_count: signals.terminalRunSampleCount,
    harness_budget_utilization_ratio: signals.budgetUtilizationRatio,
    harness_budget_exceeded_count: signals.budgetExceededCount,
    harness_database_healthy: signals.databaseHealthy ? 1 : 0,
    harness_object_store_healthy: signals.objectStoreHealthy ? 1 : 0,
    harness_sse_freshness_seconds: signals.sseFreshnessSeconds,
    harness_sse_error_rate: signals.sseErrorRate,
  };
  for (const [name, value] of Object.entries(gauges)) {
    telemetry.metric(name, "gauge", value);
  }
}
