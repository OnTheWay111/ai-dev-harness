export const OBSERVABILITY_SCHEMA_VERSION = "harness.observability.v1" as const;

export type HarnessProcess = "web" | "scheduler" | "gateway" | "worker";

export interface ObservabilityContext {
  schemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  process: HarnessProcess;
  requestId: string;
  goalId?: string;
  issueId?: string;
  runId?: string;
  receiptId?: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: "00" | "01";
}

export interface ObservabilityEnvelopeV1 {
  schema_version: typeof OBSERVABILITY_SCHEMA_VERSION;
  process: HarnessProcess;
  request_id: string;
  goal_id?: string;
  issue_id?: string;
  run_id?: string;
  receipt_id?: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  trace_flags: "00" | "01";
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;
const TRACEPARENT = /^00-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-(00|01)$/;
const PROCESSES = new Set<HarnessProcess>([
  "web", "scheduler", "gateway", "worker",
]);

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function validIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`Observability ${label} is invalid`);
  }
  return value;
}

function generatedRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

export function createObservabilityContext(input: {
  process: HarnessProcess;
  requestId?: string;
  goalId?: string;
  issueId?: string;
  runId?: string;
  receiptId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  traceFlags?: "00" | "01";
}): ObservabilityContext {
  if (!PROCESSES.has(input.process)) {
    throw new Error("Observability process is invalid");
  }
  const requestId = input.requestId
    ? validIdentifier(input.requestId, "request ID")
    : generatedRequestId();
  if (!requestId) throw new Error("Observability request ID is required");
  const traceId = input.traceId ?? randomHex(16);
  const spanId = input.spanId ?? randomHex(8);
  if (!TRACE_ID.test(traceId) || !SPAN_ID.test(spanId)) {
    throw new Error("Observability trace identity is invalid");
  }
  if (input.parentSpanId && !SPAN_ID.test(input.parentSpanId)) {
    throw new Error("Observability parent span identity is invalid");
  }
  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    process: input.process,
    requestId,
    goalId: validIdentifier(input.goalId, "goal ID"),
    issueId: validIdentifier(input.issueId, "issue ID"),
    runId: validIdentifier(input.runId, "run ID"),
    receiptId: validIdentifier(input.receiptId, "receipt ID"),
    traceId,
    spanId,
    parentSpanId: input.parentSpanId,
    traceFlags: input.traceFlags ?? "01",
  };
}

export function childObservabilityContext(
  parent: ObservabilityContext,
  process: HarnessProcess,
  identifiers: Partial<Pick<ObservabilityContext,
    "goalId" | "issueId" | "runId" | "receiptId">> = {},
): ObservabilityContext {
  return createObservabilityContext({
    process,
    requestId: parent.requestId,
    goalId: identifiers.goalId ?? parent.goalId,
    issueId: identifiers.issueId ?? parent.issueId,
    runId: identifiers.runId ?? parent.runId,
    receiptId: identifiers.receiptId ?? parent.receiptId,
    traceId: parent.traceId,
    parentSpanId: parent.spanId,
    traceFlags: parent.traceFlags,
  });
}

export function traceparent(context: ObservabilityContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

export function observabilityEnvironment(
  context: ObservabilityContext,
): ObservabilityEnvelopeV1 {
  return {
    schema_version: context.schemaVersion,
    process: context.process,
    request_id: context.requestId,
    ...(context.goalId ? { goal_id: context.goalId } : {}),
    ...(context.issueId ? { issue_id: context.issueId } : {}),
    ...(context.runId ? { run_id: context.runId } : {}),
    ...(context.receiptId ? { receipt_id: context.receiptId } : {}),
    trace_id: context.traceId,
    span_id: context.spanId,
    ...(context.parentSpanId ? { parent_span_id: context.parentSpanId } : {}),
    trace_flags: context.traceFlags,
  };
}

export function parseObservabilityEnvelope(value: unknown): ObservabilityContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Observability envelope must be an object");
  }
  const envelope = value as Record<string, unknown>;
  const allowed = new Set([
    "schema_version", "process", "request_id", "goal_id", "issue_id",
    "run_id", "receipt_id", "trace_id", "span_id", "parent_span_id",
    "trace_flags",
  ]);
  if (Object.keys(envelope).some((key) => !allowed.has(key)) ||
      envelope.schema_version !== OBSERVABILITY_SCHEMA_VERSION ||
      !PROCESSES.has(envelope.process as HarnessProcess)) {
    throw new Error("Unsupported observability envelope");
  }
  return createObservabilityContext({
    process: envelope.process as HarnessProcess,
    requestId: String(envelope.request_id ?? ""),
    goalId: envelope.goal_id as string | undefined,
    issueId: envelope.issue_id as string | undefined,
    runId: envelope.run_id as string | undefined,
    receiptId: envelope.receipt_id as string | undefined,
    traceId: String(envelope.trace_id ?? ""),
    spanId: String(envelope.span_id ?? ""),
    parentSpanId: envelope.parent_span_id as string | undefined,
    traceFlags: envelope.trace_flags as "00" | "01" | undefined,
  });
}

export function propagateRequestHeaders(input: Headers): {
  headers: Headers;
  requestId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: "00" | "01";
} {
  const headers = new Headers(input);
  const suppliedRequestId = headers.get("x-request-id")?.trim();
  const requestId = suppliedRequestId && IDENTIFIER.test(suppliedRequestId)
    ? suppliedRequestId
    : generatedRequestId();
  const suppliedTrace = headers.get("traceparent")?.trim().toLowerCase();
  const parsed = suppliedTrace?.match(TRACEPARENT);
  const traceId = parsed?.[1] ?? randomHex(16);
  const traceFlags = (parsed?.[3] ?? "01") as "00" | "01";
  const parentSpanId = parsed?.[2];
  const spanId = randomHex(8);
  headers.set("x-request-id", requestId);
  headers.set("traceparent", `00-${traceId}-${spanId}-${traceFlags}`);
  if (parentSpanId) headers.set("x-parent-span-id", parentSpanId);
  else headers.delete("x-parent-span-id");
  return { headers, requestId, traceId, spanId, parentSpanId, traceFlags };
}

export function contextFromRequest(
  request: Request,
  identifiers: Partial<Pick<ObservabilityContext,
    "goalId" | "issueId" | "runId" | "receiptId">> = {},
): ObservabilityContext {
  const propagated = propagateRequestHeaders(request.headers);
  return createObservabilityContext({
    process: "web",
    requestId: propagated.requestId,
    traceId: propagated.traceId,
    spanId: propagated.spanId,
    parentSpanId: propagated.parentSpanId,
    traceFlags: propagated.traceFlags,
    ...identifiers,
  });
}
