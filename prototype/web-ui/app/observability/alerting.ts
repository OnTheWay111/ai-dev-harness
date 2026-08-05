export type AlertSeverity = "warning" | "high" | "critical";

export interface OperationalSignals {
  observedAt: string;
  schedulerTickAgeSeconds: number;
  readyQueueDepth: number;
  oldestReadyAgeSeconds: number;
  queueDepth: number;
  workerHeartbeatAgeSeconds: number;
  offlineWorkerCount: number;
  activeRunCount: number;
  runFailureRate: number;
  terminalRunSampleCount: number;
  budgetUtilizationRatio: number;
  budgetExceededCount: number;
  databaseHealthy: boolean;
  objectStoreHealthy: boolean;
  sseFreshnessSeconds: number;
  sseErrorRate: number;
  suppressions: readonly string[];
}

export interface AlertRule {
  id: string;
  summary: string;
  severity: AlertSeverity;
  threshold: string;
  durationSeconds: number;
  dedupeSeconds: number;
  owner: string;
  runbook: string;
  breaches(signals: OperationalSignals): boolean;
}

export interface AlertTransition {
  schemaVersion: "harness.alert-transition.v1";
  ruleId: string;
  state: "firing" | "resolved";
  severity: AlertSeverity;
  summary: string;
  threshold: string;
  owner: string;
  runbook: string;
  startedAt: string;
  observedAt: string;
}

const activeRunStates = (signals: OperationalSignals) => signals.activeRunCount > 0;

export const P11_ALERT_RULES: readonly AlertRule[] = [
  {
    id: "scheduler_stalled",
    summary: "Scheduler has stopped claiming ready work",
    severity: "critical",
    threshold: "ready_queue_depth > 0 and scheduler_tick_age_seconds > 120",
    durationSeconds: 120,
    dedupeSeconds: 900,
    owner: "execution-platform",
    runbook: "docs/runbooks/alerts.md#scheduler-stalled",
    breaches: (signals) => signals.readyQueueDepth > 0 &&
      signals.schedulerTickAgeSeconds > 120,
  },
  {
    id: "worker_lost",
    summary: "An active run has lost its worker heartbeat",
    severity: "critical",
    threshold: "active_run_count > 0 and worker heartbeat is stale or offline",
    durationSeconds: 60,
    dedupeSeconds: 900,
    owner: "execution-platform",
    runbook: "docs/runbooks/alerts.md#worker-lost",
    breaches: (signals) => activeRunStates(signals) &&
      (signals.offlineWorkerCount > 0 || signals.workerHeartbeatAgeSeconds > 60),
  },
  {
    id: "run_failure_rate",
    summary: "Run failure rate exceeds the production error budget",
    severity: "high",
    threshold: "run_failure_rate > 0.20 with at least 10 terminal runs",
    durationSeconds: 300,
    dedupeSeconds: 1_800,
    owner: "runtime-quality",
    runbook: "docs/runbooks/alerts.md#run-failure-rate",
    breaches: (signals) => signals.terminalRunSampleCount >= 10 &&
      signals.runFailureRate > 0.2,
  },
  {
    id: "budget_exhaustion",
    summary: "Execution budgets are near or beyond their limit",
    severity: "high",
    threshold: "budget_utilization_ratio >= 0.90 or an execution exceeded budget",
    durationSeconds: 60,
    dedupeSeconds: 900,
    owner: "runtime-quality",
    runbook: "docs/runbooks/alerts.md#budget-exhaustion",
    breaches: (signals) => signals.budgetUtilizationRatio >= 0.9 ||
      signals.budgetExceededCount > 0,
  },
  {
    id: "queue_backlog",
    summary: "Execution queue backlog breaches capacity limits",
    severity: "high",
    threshold: "queue_depth > 100 or oldest_ready_age_seconds > 300",
    durationSeconds: 300,
    dedupeSeconds: 900,
    owner: "execution-platform",
    runbook: "docs/runbooks/alerts.md#queue-backlog",
    breaches: (signals) => signals.queueDepth > 100 ||
      signals.oldestReadyAgeSeconds > 300,
  },
  {
    id: "database_unavailable",
    summary: "Primary PostgreSQL health probe is failing",
    severity: "critical",
    threshold: "database_healthy = 0",
    durationSeconds: 30,
    dedupeSeconds: 900,
    owner: "data-platform",
    runbook: "docs/runbooks/alerts.md#database-unavailable",
    breaches: (signals) => !signals.databaseHealthy,
  },
  {
    id: "object_store_unavailable",
    summary: "Immutable artifact object store probe is failing",
    severity: "critical",
    threshold: "object_store_healthy = 0",
    durationSeconds: 120,
    dedupeSeconds: 900,
    owner: "data-platform",
    runbook: "docs/runbooks/alerts.md#object-store-unavailable",
    breaches: (signals) => !signals.objectStoreHealthy,
  },
  {
    id: "sse_stale",
    summary: "Workbench event stream is stale or erroring",
    severity: "high",
    threshold: "sse_freshness_seconds > 15 or sse_error_rate > 0.10",
    durationSeconds: 120,
    dedupeSeconds: 900,
    owner: "control-plane",
    runbook: "docs/runbooks/alerts.md#sse-stale",
    breaches: (signals) => signals.sseFreshnessSeconds > 15 ||
      signals.sseErrorRate > 0.1,
  },
] as const;

interface RuleState {
  pendingSince?: string;
  activeSince?: string;
  lastNotificationAt?: string;
}

function epoch(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Alert observation time is invalid");
  return parsed;
}

export class AlertEvaluator {
  private readonly rules: readonly AlertRule[];
  private readonly state = new Map<string, RuleState>();

  constructor(rules: readonly AlertRule[] = P11_ALERT_RULES) {
    this.rules = rules;
  }

  evaluate(signals: OperationalSignals): readonly AlertTransition[] {
    const now = epoch(signals.observedAt);
    const suppressed = new Set(signals.suppressions);
    const transitions: AlertTransition[] = [];

    for (const rule of this.rules) {
      const state = this.state.get(rule.id) ?? {};
      if (!rule.breaches(signals)) {
        if (state.activeSince) {
          transitions.push(this.transition(rule, "resolved", state.activeSince,
            signals.observedAt));
        }
        this.state.delete(rule.id);
        continue;
      }

      state.pendingSince ??= signals.observedAt;
      const durationElapsed = now - epoch(state.pendingSince) >=
        rule.durationSeconds * 1_000;
      if (!durationElapsed || suppressed.has(rule.id)) {
        this.state.set(rule.id, state);
        continue;
      }

      if (!state.activeSince) {
        state.activeSince = state.pendingSince;
        state.lastNotificationAt = signals.observedAt;
        transitions.push(this.transition(rule, "firing", state.activeSince,
          signals.observedAt));
      } else if (state.lastNotificationAt &&
        now - epoch(state.lastNotificationAt) >= rule.dedupeSeconds * 1_000) {
        state.lastNotificationAt = signals.observedAt;
        transitions.push(this.transition(rule, "firing", state.activeSince,
          signals.observedAt));
      }
      this.state.set(rule.id, state);
    }
    return transitions;
  }

  private transition(
    rule: AlertRule,
    state: AlertTransition["state"],
    startedAt: string,
    observedAt: string,
  ): AlertTransition {
    return {
      schemaVersion: "harness.alert-transition.v1",
      ruleId: rule.id,
      state,
      severity: rule.severity,
      summary: rule.summary,
      threshold: rule.threshold,
      owner: rule.owner,
      runbook: rule.runbook,
      startedAt,
      observedAt,
    };
  }
}
