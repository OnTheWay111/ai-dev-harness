import type { ObservabilityContext } from "./context.ts";
import { observabilityEnvironment } from "./context.ts";

export type TelemetryMetricKind = "counter" | "gauge" | "histogram";
export type TelemetryLevel = "debug" | "info" | "warn" | "error" | "audit";

export interface TelemetryEntry {
  schema_version: "harness.telemetry.v1";
  timestamp: string;
  level: TelemetryLevel;
  event: string;
  context?: ReturnType<typeof observabilityEnvironment>;
  attributes?: unknown;
  metric?: {
    name: string;
    kind: TelemetryMetricKind;
    value: number;
    labels: Record<string, string>;
  };
}

export interface OperationalTelemetry {
  event(
    event: string,
    context: ObservabilityContext,
    attributes?: Readonly<Record<string, unknown>>,
    level?: TelemetryLevel,
  ): void;
  metric(
    name: string,
    kind: TelemetryMetricKind,
    value: number,
    labels?: Readonly<Record<string, string>>,
  ): void;
}

const SENSITIVE_KEY = /(authorization|cookie|credential|secret|token|password|passphrase|database.?url|connection.?string|private.?key|actor.?email)/i;
const METRIC_NAME = /^[a-z][a-z0-9_]{2,127}$/;
const LABEL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const EVENT_NAME = /^[a-z][a-z0-9_.-]{2,127}$/;

function sanitizeString(value: string): string {
  return value
    .replace(/bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/(?:postgres(?:ql)?|mysql|redis):\/\/[^\s'\"]+/gi,
      "[REDACTED_CONNECTION_URL]")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/g,
      "[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[REDACTED_IDENTITY]")
    .slice(0, 4_000);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1),
      ]));
  }
  return String(value).slice(0, 1_000);
}

export class StructuredTelemetry implements OperationalTelemetry {
  private readonly sink: (entry: TelemetryEntry) => void;
  private readonly clock: () => Date;

  constructor(input: {
    sink?: (entry: TelemetryEntry) => void;
    clock?: () => Date;
  } = {}) {
    this.sink = input.sink ?? ((entry) => console.log(JSON.stringify(entry)));
    this.clock = input.clock ?? (() => new Date());
  }

  event(
    event: string,
    context: ObservabilityContext,
    attributes: Readonly<Record<string, unknown>> = {},
    level: TelemetryLevel = "info",
  ): void {
    if (!EVENT_NAME.test(event)) throw new Error("Telemetry event name is invalid");
    this.sink({
      schema_version: "harness.telemetry.v1",
      timestamp: this.clock().toISOString(),
      level,
      event,
      context: observabilityEnvironment(context),
      attributes: sanitize(attributes),
    });
  }

  metric(
    name: string,
    kind: TelemetryMetricKind,
    value: number,
    labels: Readonly<Record<string, string>> = {},
  ): void {
    if (!METRIC_NAME.test(name) || !Number.isFinite(value) ||
      Object.entries(labels).some(([key, item]) =>
        !LABEL_NAME.test(key) || item.length > 100 || /\r|\n/.test(item))) {
      throw new Error("Telemetry metric is invalid");
    }
    this.sink({
      schema_version: "harness.telemetry.v1",
      timestamp: this.clock().toISOString(),
      level: "info",
      event: "metric.observation",
      metric: { name, kind, value, labels: { ...labels } },
    });
  }
}

let defaultTelemetry: StructuredTelemetry | undefined;

export function getOperationalTelemetry(): StructuredTelemetry {
  defaultTelemetry ??= new StructuredTelemetry();
  return defaultTelemetry;
}
