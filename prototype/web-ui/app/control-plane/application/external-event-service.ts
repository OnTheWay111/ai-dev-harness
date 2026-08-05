import type {
  AutoDevRunEventV1,
  EventIngestResult,
  ExecutionEventRepository,
} from "../ports/execution-event-repository.ts";
import { parseObservabilityEnvelope } from "../../observability/context.ts";
import type { OperationalTelemetry } from "../../observability/telemetry.ts";

export class ExternalEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalEventValidationError";
  }
}

export class ExternalEventConflictError extends Error {
  constructor() {
    super("External source event identity was reused with different content");
    this.name = "ExternalEventConflictError";
  }
}

export function normalizeAutoDevRunEvent(
  raw: Readonly<Record<string, unknown>>,
  externalRunId: string,
  fallbackExternalTaskId = "",
): AutoDevRunEventV1 {
  const phase = String(raw.phase ?? "unknown");
  const level = String(raw.level ?? "info").toLowerCase();
  const explicitStatus = raw.status ??
    (raw.extra && typeof raw.extra === "object"
      ? (raw.extra as Record<string, unknown>).status
      : undefined);
  let status = String(explicitStatus ?? "running");
  if (explicitStatus === undefined) {
    if (["done", "complete", "loop_complete"].includes(phase)) status = "succeeded";
    else if (level === "error") status = "failed";
    else if (["stop", "cancelled"].includes(phase)) status = "cancelled";
  }
  let observability;
  if (raw.observability !== undefined) {
    observability = parseObservabilityEnvelope(raw.observability);
  }
  return {
    schemaVersion: String(raw.schema_version ?? "") as "autodev.run-event.v1",
    sourceEventId: String(raw.event_id ?? ""),
    externalRunId,
    externalTaskId: String(raw.task_id ?? "") || fallbackExternalTaskId,
    sequence: Number(raw.sequence),
    occurredAt: String(raw.timestamp ?? ""),
    phase,
    status,
    message: String(raw.message ?? ""),
    observability,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validate(event: AutoDevRunEventV1): void {
  if (event.schemaVersion !== "autodev.run-event.v1") {
    throw new ExternalEventValidationError("Unsupported AutoDev event schema");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(event.sourceEventId)) {
    throw new ExternalEventValidationError("Invalid source event id");
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new ExternalEventValidationError("Invalid source event sequence");
  }
  if (!event.externalRunId.trim() || !event.externalTaskId.trim()) {
    throw new ExternalEventValidationError("External run and task identities are required");
  }
  if (!Number.isFinite(new Date(event.occurredAt).getTime())) {
    throw new ExternalEventValidationError("Invalid event timestamp");
  }
  if (!event.phase.trim() || !event.status.trim()) {
    throw new ExternalEventValidationError("Event phase and status are required");
  }
  if (event.observability && event.observability.runId === undefined) {
    throw new ExternalEventValidationError(
      "Worker observability context requires the authoritative run identity",
    );
  }
}

export class ExternalEventService {
  private readonly repository: ExecutionEventRepository;
  private readonly telemetry?: OperationalTelemetry;

  constructor(dependencies: {
    repository: ExecutionEventRepository;
    telemetry?: OperationalTelemetry;
  }) {
    this.repository = dependencies.repository;
    this.telemetry = dependencies.telemetry;
  }

  async ingest(event: AutoDevRunEventV1): Promise<EventIngestResult> {
    validate(event);
    const digest = await sha256(event);
    const result = await this.repository.ingest({ event, digest });
    this.telemetry?.metric("harness_worker_events_total", "counter", 1, {
      disposition: result.disposition,
    });
    if (event.observability) {
      this.telemetry?.event("worker.event.ingested", event.observability, {
        sourceEventId: event.sourceEventId,
        phase: event.phase,
        status: event.status,
        disposition: result.disposition,
      }, result.disposition === "conflict" ? "error" : "info");
    }
    if (result.disposition === "conflict") throw new ExternalEventConflictError();
    if (["run_not_found", "identity_mismatch"].includes(result.disposition)) {
      throw new ExternalEventValidationError(
        result.disposition === "run_not_found"
          ? "External run is not registered"
          : "External task does not own the registered run",
      );
    }
    return result;
  }
}
