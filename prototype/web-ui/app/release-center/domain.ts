import {
  validateP12CanaryReport,
} from "../reliability/p12-canary-gate.ts";
import {
  releaseAttestationDigest,
  validateP12ProductionReleaseGate,
} from "../reliability/p12-production-release-gate.ts";
import {
  P12_PRODUCTION_GATE_IDS,
  P12_RELEASE_SIGNATURE_ROLES,
} from "./constants.ts";

export {
  P12_PRODUCTION_GATE_IDS,
  P12_RELEASE_SIGNATURE_ROLES,
} from "./constants.ts";

const HOUR_MS = 60 * 60 * 1_000;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const EVIDENCE_REF = /^(?:artifact:sha256:[0-9a-f]{64}|[a-z][a-z0-9-]*:[A-Za-z0-9._:-]+)$/;

export const canaryStatuses = ["draft", "observing", "stopped", "passed"] as const;
export type CanaryStatus = (typeof canaryStatuses)[number];
export type ProductionGateId = (typeof P12_PRODUCTION_GATE_IDS)[number];
export type ReleaseSignatureRole = (typeof P12_RELEASE_SIGNATURE_ROLES)[number];
export type ProductionReleaseStatus = "draft" | "awaiting_signatures" | "approved";

export class ReleaseCenterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseCenterValidationError";
  }
}

function required(value: string, label: string, maximum = 4_000): string {
  const text = value?.trim();
  if (!text || text.length > maximum) {
    throw new ReleaseCenterValidationError(`${label} is required and bounded`);
  }
  return text;
}

function id(value: string, label: string): string {
  const text = required(value, label, 128);
  if (!SAFE_ID.test(text)) throw new ReleaseCenterValidationError(`${label} is invalid`);
  return text;
}

function strings(value: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ReleaseCenterValidationError(`${label} must be a non-empty bounded list`);
  }
  return value.map((item, index) => required(item, `${label}[${index}]`, 2_000));
}

function evidenceRefs(value: readonly string[], label: string): string[] {
  const refs = strings(value, label);
  if (refs.some((ref) => !EVIDENCE_REF.test(ref))) {
    throw new ReleaseCenterValidationError(`${label} contains an invalid evidence reference`);
  }
  return refs;
}

function iso(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.endsWith("Z")) {
    throw new ReleaseCenterValidationError(`${label} must be an ISO UTC timestamp`);
  }
  return new Date(parsed).toISOString();
}

function immutable<T>(value: T): T {
  return structuredClone(value);
}

export interface CanaryWindow {
  attempt: number;
  sequence: number;
  startedAt: string;
  endedAt: string;
  status: "healthy" | "unhealthy";
  p0Count: number;
  p1Count: number;
  evidenceRefs: string[];
  recordedBy: string;
}

export interface CanaryDefectEvent {
  id: string;
  attempt: number;
  kind: "defect";
  severity: "P0" | "P1" | "P2" | "P3";
  observedAt: string;
  ownerId: string;
  workaround?: string;
  status: string;
  evidenceRefs: string[];
  recordedBy: string;
}

export interface CanaryAlertEvent {
  id: string;
  attempt: number;
  kind: "alert";
  severity: "P0" | "P1" | "P2" | "P3";
  observedAt: string;
  ownerId: string;
  resolved: boolean;
  evidenceRefs: string[];
  recordedBy: string;
}

export interface CanaryInterventionEvent {
  id: string;
  attempt: number;
  kind: "intervention";
  observedAt: string;
  ownerId: string;
  reason: string;
  evidenceRefs: string[];
  recordedBy: string;
}

export type CanaryEvent =
  | CanaryDefectEvent
  | CanaryAlertEvent
  | CanaryInterventionEvent;

export interface CanaryReport {
  schemaVersion: "harness.p12-canary-report.v1";
  canaryId: string;
  status: "passed";
  project: {
    projectId: string;
    internal: true;
    risk: "low";
    ownerId: string;
    approvedAt: string;
  };
  scope: {
    goalId: string;
    goalContractVersion: number;
    allowedAreas: string[];
    excludedAreas: string[];
  };
  conditions: {
    success: string[];
    stop: string[];
    rollbackRunbook: string;
    stopRunbook: string;
  };
  observation: {
    requiredDurationHours: 12;
    startedAt: string;
    endedAt: string;
    windows: Array<Omit<CanaryWindow, "attempt" | "recordedBy">>;
  };
  defects: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
  interventions: Array<Record<string, unknown>>;
  goalVerification: {
    status: "passed";
    verificationId: string;
    completedAt: string;
    evidenceRefs: string[];
  };
  gaps: [];
  result: "passed";
}

export interface CanaryAggregate {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  candidateCommit: string;
  status: CanaryStatus;
  attempt: number;
  goalContractVersion: number;
  allowedAreas: string[];
  excludedAreas: string[];
  successConditions: string[];
  stopConditions: string[];
  rollbackRunbook: string;
  stopRunbook: string;
  ownerId: string | null;
  approvedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  report: CanaryReport | null;
  windows: CanaryWindow[];
  events: CanaryEvent[];
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCanaryInput {
  canaryId: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  candidateCommit: string;
  goalContractVersion: number;
  allowedAreas: readonly string[];
  excludedAreas: readonly string[];
  successConditions: readonly string[];
  stopConditions: readonly string[];
  rollbackRunbook: string;
  stopRunbook: string;
  createdBy: string;
  now: Date;
}

function runbook(value: string, label: string): string {
  const path = required(value, label, 1_000);
  if (!path.startsWith("docs/runbooks/") || !path.endsWith(".md")) {
    throw new ReleaseCenterValidationError(`${label} must reference a repository Runbook`);
  }
  return path;
}

export function createCanary(input: CreateCanaryInput): CanaryAggregate {
  if (!COMMIT_SHA.test(input.candidateCommit)) {
    throw new ReleaseCenterValidationError("candidateCommit must be a full lowercase Git SHA");
  }
  if (!Number.isInteger(input.goalContractVersion) || input.goalContractVersion < 1) {
    throw new ReleaseCenterValidationError("goalContractVersion must be positive");
  }
  const allowedAreas = strings(input.allowedAreas, "allowedAreas");
  const excludedAreas = strings(input.excludedAreas, "excludedAreas");
  if (allowedAreas.some((area) => excludedAreas.includes(area))) {
    throw new ReleaseCenterValidationError("allowed and excluded scope overlap");
  }
  const now = input.now.toISOString();
  return {
    id: id(input.canaryId, "canaryId"),
    organizationId: id(input.organizationId, "organizationId"),
    projectId: id(input.projectId, "projectId"),
    goalId: id(input.goalId, "goalId"),
    candidateCommit: input.candidateCommit,
    status: "draft",
    attempt: 1,
    goalContractVersion: input.goalContractVersion,
    allowedAreas,
    excludedAreas,
    successConditions: strings(input.successConditions, "successConditions"),
    stopConditions: strings(input.stopConditions, "stopConditions"),
    rollbackRunbook: runbook(input.rollbackRunbook, "rollbackRunbook"),
    stopRunbook: runbook(input.stopRunbook, "stopRunbook"),
    ownerId: null,
    approvedAt: null,
    startedAt: null,
    endedAt: null,
    report: null,
    windows: [],
    events: [],
    version: 1,
    createdBy: id(input.createdBy, "createdBy"),
    createdAt: now,
    updatedAt: now,
  };
}

export function approveCanary(
  value: CanaryAggregate,
  input: { actorId: string; reason: string; now: Date },
): CanaryAggregate {
  if (value.status !== "draft") {
    throw new ReleaseCenterValidationError("only a draft Canary can be approved");
  }
  required(input.reason, "reason");
  const now = input.now.toISOString();
  return {
    ...immutable(value),
    status: "observing",
    ownerId: id(input.actorId, "actorId"),
    approvedAt: now,
    startedAt: now,
    endedAt: null,
    version: value.version + 1,
    updatedAt: now,
  };
}

export function restartCanary(
  value: CanaryAggregate,
  input: { actorId: string; reason: string; now: Date },
): CanaryAggregate {
  if (value.status !== "stopped") {
    throw new ReleaseCenterValidationError("only a stopped Canary can restart");
  }
  required(input.reason, "reason");
  const now = input.now.toISOString();
  return {
    ...immutable(value),
    status: "observing",
    attempt: value.attempt + 1,
    ownerId: id(input.actorId, "actorId"),
    approvedAt: now,
    startedAt: now,
    endedAt: null,
    report: null,
    version: value.version + 1,
    updatedAt: now,
  };
}

function count(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ReleaseCenterValidationError(`${label} must be a non-negative integer`);
  }
  return value;
}

export function recordCanaryWindow(
  value: CanaryAggregate,
  input: {
    actorId: string;
    window: Omit<CanaryWindow, "attempt" | "recordedBy">;
    now: Date;
  },
): CanaryAggregate {
  if (value.status !== "observing" || !value.startedAt) {
    throw new ReleaseCenterValidationError("Canary is not observing");
  }
  const current = value.windows.filter((window) => window.attempt === value.attempt);
  if (input.window.sequence !== current.length + 1) {
    throw new ReleaseCenterValidationError("Canary window sequence must be contiguous");
  }
  const startedAt = iso(input.window.startedAt, "window.startedAt");
  const endedAt = iso(input.window.endedAt, "window.endedAt");
  const expectedStart = current.at(-1)?.endedAt ?? value.startedAt;
  const startMillis = Date.parse(startedAt);
  const endMillis = Date.parse(endedAt);
  if (startedAt !== expectedStart || endMillis <= startMillis || endMillis - startMillis > HOUR_MS) {
    throw new ReleaseCenterValidationError("Canary windows must be contiguous and at most one hour");
  }
  if (endMillis > input.now.getTime()) {
    throw new ReleaseCenterValidationError("Canary window cannot end in the future");
  }
  if (input.window.status !== "healthy" && input.window.status !== "unhealthy") {
    throw new ReleaseCenterValidationError("Canary window status is invalid");
  }
  const p0Count = count(input.window.p0Count, "window.p0Count");
  const p1Count = count(input.window.p1Count, "window.p1Count");
  const window: CanaryWindow = {
    attempt: value.attempt,
    sequence: input.window.sequence,
    startedAt,
    endedAt,
    status: input.window.status,
    p0Count,
    p1Count,
    evidenceRefs: evidenceRefs(input.window.evidenceRefs, "window.evidenceRefs"),
    recordedBy: id(input.actorId, "actorId"),
  };
  const stopped = window.status !== "healthy" || p0Count > 0 || p1Count > 0;
  return {
    ...immutable(value),
    windows: [...value.windows.map(immutable), window],
    status: stopped ? "stopped" : "observing",
    endedAt: stopped ? endedAt : null,
    version: value.version + 1,
    updatedAt: input.now.toISOString(),
  };
}

export type NewCanaryEvent =
  | Omit<CanaryDefectEvent, "attempt" | "recordedBy">
  | Omit<CanaryAlertEvent, "attempt" | "recordedBy">
  | Omit<CanaryInterventionEvent, "attempt" | "recordedBy">;

export function recordCanaryEvent(
  value: CanaryAggregate,
  input: { actorId: string; event: NewCanaryEvent; now: Date },
): CanaryAggregate {
  if (value.status !== "observing" || !value.startedAt) {
    throw new ReleaseCenterValidationError("Canary is not observing");
  }
  if (value.events.some((event) =>
    event.attempt === value.attempt && event.id === input.event.id
  )) throw new ReleaseCenterValidationError("Canary event already exists");
  const common = {
    id: id(input.event.id, "event.id"),
    attempt: value.attempt,
    observedAt: iso(input.event.observedAt, "event.observedAt"),
    ownerId: id(input.event.ownerId, "event.ownerId"),
    evidenceRefs: evidenceRefs(input.event.evidenceRefs, "event.evidenceRefs"),
    recordedBy: id(input.actorId, "actorId"),
  };
  const observed = Date.parse(common.observedAt);
  if (observed < Date.parse(value.startedAt) || observed > input.now.getTime()) {
    throw new ReleaseCenterValidationError("Canary event is outside the active observation");
  }
  let event: CanaryEvent;
  let stopped = false;
  if (input.event.kind === "intervention") {
    event = { ...common, kind: "intervention", reason: required(input.event.reason, "event.reason") };
  } else {
    if (!["P0", "P1", "P2", "P3"].includes(input.event.severity)) {
      throw new ReleaseCenterValidationError("event.severity is invalid");
    }
    stopped = input.event.severity === "P0" || input.event.severity === "P1";
    if (input.event.kind === "alert") {
      event = { ...common, kind: "alert", severity: input.event.severity, resolved: input.event.resolved === true };
    } else {
      const workaround = input.event.severity === "P2"
        ? required(input.event.workaround ?? "", "event.workaround")
        : input.event.workaround?.trim();
      event = {
        ...common,
        kind: "defect",
        severity: input.event.severity,
        status: required(input.event.status, "event.status", 200),
        ...(workaround ? { workaround } : {}),
      };
    }
  }
  return {
    ...immutable(value),
    events: [...value.events.map(immutable), event],
    status: stopped ? "stopped" : "observing",
    endedAt: stopped ? input.now.toISOString() : null,
    version: value.version + 1,
    updatedAt: input.now.toISOString(),
  };
}

export function resolveCanaryAlert(
  value: CanaryAggregate,
  input: { actorId: string; eventId: string; reason: string; now: Date },
): CanaryAggregate {
  if (value.status !== "observing") {
    throw new ReleaseCenterValidationError("Canary is not observing");
  }
  required(input.reason, "reason");
  const index = value.events.findIndex((event) =>
    event.attempt === value.attempt && event.id === input.eventId && event.kind === "alert"
  );
  if (index < 0) throw new ReleaseCenterValidationError("Canary alert was not found");
  const events = value.events.map(immutable);
  events[index] = { ...(events[index] as CanaryAlertEvent), resolved: true };
  return {
    ...immutable(value),
    events,
    version: value.version + 1,
    updatedAt: input.now.toISOString(),
  };
}

export interface PassedGoalVerification {
  id: string;
  verdict: "passed";
  verifiedAt: string;
  evidenceRefs: string[];
}

export function finalizeCanary(
  value: CanaryAggregate,
  input: { verification: PassedGoalVerification; now: Date },
): CanaryAggregate {
  if (value.status !== "observing" || !value.startedAt || !value.approvedAt || !value.ownerId) {
    throw new ReleaseCenterValidationError("Canary is not eligible for finalization");
  }
  const windows = value.windows.filter((window) => window.attempt === value.attempt);
  const endedAt = windows.at(-1)?.endedAt;
  if (!endedAt || windows.length < 12 ||
    Date.parse(endedAt) - Date.parse(value.startedAt) < 12 * HOUR_MS) {
    throw new ReleaseCenterValidationError("Canary requires 12 continuous hours");
  }
  const events = value.events.filter((event) => event.attempt === value.attempt);
  const defects = events.filter((event): event is CanaryDefectEvent => event.kind === "defect");
  const alerts = events.filter((event): event is CanaryAlertEvent => event.kind === "alert");
  const interventions = events.filter(
    (event): event is CanaryInterventionEvent => event.kind === "intervention",
  );
  const report: CanaryReport = {
    schemaVersion: "harness.p12-canary-report.v1",
    canaryId: value.id,
    status: "passed",
    project: {
      projectId: value.projectId,
      internal: true,
      risk: "low",
      ownerId: value.ownerId,
      approvedAt: value.approvedAt,
    },
    scope: {
      goalId: value.goalId,
      goalContractVersion: value.goalContractVersion,
      allowedAreas: immutable(value.allowedAreas),
      excludedAreas: immutable(value.excludedAreas),
    },
    conditions: {
      success: immutable(value.successConditions),
      stop: immutable(value.stopConditions),
      rollbackRunbook: value.rollbackRunbook,
      stopRunbook: value.stopRunbook,
    },
    observation: {
      requiredDurationHours: 12,
      startedAt: value.startedAt,
      endedAt,
      windows: windows.map((window) => ({
        sequence: window.sequence,
        startedAt: window.startedAt,
        endedAt: window.endedAt,
        status: window.status,
        p0Count: window.p0Count,
        p1Count: window.p1Count,
        evidenceRefs: immutable(window.evidenceRefs),
      })),
    },
    defects: defects.map((event) => ({
      id: event.id,
      severity: event.severity,
      ownerId: event.ownerId,
      status: event.status,
      ...(event.workaround ? { workaround: event.workaround } : {}),
    })),
    alerts: alerts.map((event) => ({
      id: event.id,
      severity: event.severity,
      observedAt: event.observedAt,
      ownerId: event.ownerId,
      resolved: event.resolved,
      evidenceRefs: immutable(event.evidenceRefs),
    })),
    interventions: interventions.map((event) => ({
      id: event.id,
      observedAt: event.observedAt,
      ownerId: event.ownerId,
      reason: event.reason,
      evidenceRefs: immutable(event.evidenceRefs),
    })),
    goalVerification: {
      status: "passed",
      verificationId: id(input.verification.id, "verification.id"),
      completedAt: iso(input.verification.verifiedAt, "verification.verifiedAt"),
      evidenceRefs: evidenceRefs(input.verification.evidenceRefs, "verification.evidenceRefs"),
    },
    gaps: [],
    result: "passed",
  };
  validateP12CanaryReport(report, { now: input.now });
  return {
    ...immutable(value),
    status: "passed",
    endedAt,
    report,
    version: value.version + 1,
    updatedAt: input.now.toISOString(),
  };
}

export interface ProductionGateCheck {
  gateId: ProductionGateId;
  status: "passed";
  ownerRole: ReleaseSignatureRole;
  checkedAt: string;
  evidenceRefs: string[];
  checkedBy: string;
}

export interface ProductionSignature {
  role: ReleaseSignatureRole;
  signerId: string;
  signedAt: string;
  decision: "approved";
  reason: string;
  authenticationMethod: "oidc";
  requestId: string;
  auditReceiptId: string;
  attestationDigest: string;
}

export interface ProductionReleaseReport {
  schemaVersion: "harness.p12-production-release-gate.v1";
  releaseId: string;
  target: "production-v1";
  candidateCommit: string;
  evaluatedAt: string;
  canary: CanaryReport;
  gates: Array<Omit<ProductionGateCheck, "checkedBy">>;
  defects: {
    p0Count: 0;
    p1Count: 0;
    p2: Array<{
      id: string;
      ownerId: string;
      workaround: string;
      evidenceRefs: string[];
    }>;
  };
  signatures: ProductionSignature[];
  gaps: [];
  result: "approved";
}

export interface ProductionReleaseAggregate {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  canaryId: string;
  candidateCommit: string;
  status: ProductionReleaseStatus;
  canaryReport: CanaryReport;
  gates: ProductionGateCheck[];
  defects: ProductionReleaseReport["defects"];
  evaluatedAt: string | null;
  attestationDigest: string | null;
  signatures: ProductionSignature[];
  report: ProductionReleaseReport | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function createProductionRelease(input: {
  id: string;
  canary: CanaryAggregate;
  actorId: string;
  now: Date;
}): ProductionReleaseAggregate {
  if (input.canary.status !== "passed" || !input.canary.report) {
    throw new ReleaseCenterValidationError("Production release requires a passed Canary");
  }
  const p2 = input.canary.events
    .filter((event): event is CanaryDefectEvent =>
      event.attempt === input.canary.attempt && event.kind === "defect" && event.severity === "P2"
    )
    .map((event) => ({
      id: event.id,
      ownerId: event.ownerId,
      workaround: required(event.workaround ?? "", "P2 workaround"),
      evidenceRefs: immutable(event.evidenceRefs),
    }));
  const now = input.now.toISOString();
  return {
    id: id(input.id, "releaseId"),
    organizationId: input.canary.organizationId,
    projectId: input.canary.projectId,
    goalId: input.canary.goalId,
    canaryId: input.canary.id,
    candidateCommit: input.canary.candidateCommit,
    status: "draft",
    canaryReport: immutable(input.canary.report),
    gates: [],
    defects: { p0Count: 0, p1Count: 0, p2 },
    evaluatedAt: null,
    attestationDigest: null,
    signatures: [],
    report: null,
    version: 1,
    createdBy: id(input.actorId, "actorId"),
    createdAt: now,
    updatedAt: now,
  };
}

export function recordProductionGate(
  value: ProductionReleaseAggregate,
  input: {
    actorId: string;
    gateId: ProductionGateId;
    ownerRole: ReleaseSignatureRole;
    evidenceRefs: readonly string[];
    now: Date;
  },
): ProductionReleaseAggregate {
  if (value.status !== "draft") {
    throw new ReleaseCenterValidationError("Production release evidence is locked after evaluation");
  }
  if (!P12_PRODUCTION_GATE_IDS.includes(input.gateId) ||
    !P12_RELEASE_SIGNATURE_ROLES.includes(input.ownerRole)) {
    throw new ReleaseCenterValidationError("Production gate or owner role is invalid");
  }
  const gate: ProductionGateCheck = {
    gateId: input.gateId,
    status: "passed",
    ownerRole: input.ownerRole,
    checkedAt: input.now.toISOString(),
    evidenceRefs: evidenceRefs(input.evidenceRefs, "gate.evidenceRefs"),
    checkedBy: id(input.actorId, "actorId"),
  };
  return {
    ...immutable(value),
    gates: [...value.gates.filter((existing) => existing.gateId !== gate.gateId).map(immutable), gate],
    version: value.version + 1,
    updatedAt: input.now.toISOString(),
  };
}

function productionReport(
  value: ProductionReleaseAggregate,
  signatures: ProductionSignature[],
  evaluatedAt: string,
): ProductionReleaseReport {
  return {
    schemaVersion: "harness.p12-production-release-gate.v1",
    releaseId: value.id,
    target: "production-v1",
    candidateCommit: value.candidateCommit,
    evaluatedAt,
    canary: immutable(value.canaryReport),
    gates: value.gates.map((gate) => ({
      gateId: gate.gateId,
      status: gate.status,
      ownerRole: gate.ownerRole,
      checkedAt: gate.checkedAt,
      evidenceRefs: immutable(gate.evidenceRefs),
    })),
    defects: immutable(value.defects),
    signatures: immutable(signatures),
    gaps: [],
    result: "approved",
  };
}

export function evaluateProductionRelease(
  value: ProductionReleaseAggregate,
  input: { actorId: string; now: Date },
): ProductionReleaseAggregate {
  if (value.status !== "draft") {
    throw new ReleaseCenterValidationError("Production release is already evaluated");
  }
  const seen = new Set(value.gates.map(({ gateId }) => gateId));
  if (P12_PRODUCTION_GATE_IDS.some((gateId) => !seen.has(gateId)) ||
    value.gates.length !== P12_PRODUCTION_GATE_IDS.length) {
    throw new ReleaseCenterValidationError("Production release requires all ten gates");
  }
  id(input.actorId, "actorId");
  const evaluatedAt = input.now.toISOString();
  const unsigned = productionReport(value, [], evaluatedAt);
  const attestationDigest = releaseAttestationDigest(unsigned);
  return {
    ...immutable(value),
    status: "awaiting_signatures",
    evaluatedAt,
    attestationDigest,
    report: unsigned,
    version: value.version + 1,
    updatedAt: evaluatedAt,
  };
}

export function signProductionRelease(
  value: ProductionReleaseAggregate,
  input: {
    actorId: string;
    role: ReleaseSignatureRole;
    reason: string;
    requestId: string;
    auditReceiptId: string;
    now: Date;
  },
): ProductionReleaseAggregate {
  if (value.status !== "awaiting_signatures" || !value.evaluatedAt ||
    !value.attestationDigest) {
    throw new ReleaseCenterValidationError("Production release is not awaiting signatures");
  }
  if (!P12_RELEASE_SIGNATURE_ROLES.includes(input.role)) {
    throw new ReleaseCenterValidationError("signature role is invalid");
  }
  const signerId = id(input.actorId, "actorId");
  if (value.signatures.some(({ role }) => role === input.role)) {
    throw new ReleaseCenterValidationError("signature role is already approved");
  }
  const reason = required(input.reason, "reason");
  if (reason.length < 20) throw new ReleaseCenterValidationError("signature reason is too short");
  const signature: ProductionSignature = {
    role: input.role,
    signerId,
    signedAt: input.now.toISOString(),
    decision: "approved",
    reason,
    authenticationMethod: "oidc",
    requestId: id(input.requestId, "requestId"),
    auditReceiptId: id(input.auditReceiptId, "auditReceiptId"),
    attestationDigest: value.attestationDigest,
  };
  const signatures = [...value.signatures.map(immutable), signature];
  const report = productionReport(value, signatures, value.evaluatedAt);
  if (signatures.length === P12_RELEASE_SIGNATURE_ROLES.length) {
    validateP12ProductionReleaseGate(report, { now: input.now });
  }
  return {
    ...immutable(value),
    status: signatures.length === P12_RELEASE_SIGNATURE_ROLES.length
      ? "approved"
      : "awaiting_signatures",
    signatures,
    report,
    version: value.version + 1,
    updatedAt: input.now.toISOString(),
  };
}

export function canaryProgress(value: CanaryAggregate): {
  completedHours: number;
  requiredHours: 12;
  windowCount: number;
} {
  const windows = value.windows.filter((window) => window.attempt === value.attempt);
  const completedHours = windows.reduce((total, window) =>
    total + (Date.parse(window.endedAt) - Date.parse(window.startedAt)) / HOUR_MS, 0);
  return { completedHours, requiredHours: 12, windowCount: windows.length };
}
