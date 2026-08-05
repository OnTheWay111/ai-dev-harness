const SCHEMA_VERSION = "harness.p12-canary-report.v1";
export const P12_CANARY_MINIMUM_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const PLACEHOLDER = /(?:^|[-_.])(test|example|placeholder|unknown|tbd|todo)(?:$|[-_.])/i;
const EVIDENCE_REF = /^(?:artifact:sha256:[0-9a-f]{64}|[a-z][a-z0-9-]*:[A-Za-z0-9._:-]+)$/;

type ObjectValue = Record<string, unknown>;

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as ObjectValue;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value as string[];
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  const text = string(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || !text.endsWith("Z")) {
    throw new Error(`${label} must be an ISO UTC timestamp`);
  }
  return parsed;
}

function id(value: unknown, label: string, rejectPlaceholder = false): string {
  const text = string(value, label);
  if (!SAFE_ID.test(text) || (rejectPlaceholder && PLACEHOLDER.test(text))) {
    throw new Error(`${label} is invalid or a placeholder`);
  }
  return text;
}

function evidenceRefs(value: unknown, label: string): string[] {
  const refs = strings(value, label);
  if (refs.some((item) => !EVIDENCE_REF.test(item))) {
    throw new Error(`${label} contains an invalid evidence reference`);
  }
  return refs;
}

function validateObservation(raw: ObjectValue, now: Date): {
  durationHours: number;
  windowCount: number;
} {
  if (integer(raw.requiredDurationHours, "observation.requiredDurationHours") !==
      P12_CANARY_MINIMUM_HOURS) {
    throw new Error("Canary requires exactly the 48-hour minimum gate");
  }
  const startedAt = timestamp(raw.startedAt, "observation.startedAt");
  const endedAt = timestamp(raw.endedAt, "observation.endedAt");
  if (endedAt > now.getTime()) throw new Error("Canary observation cannot end in the future");
  const durationHours = (endedAt - startedAt) / HOUR_MS;
  if (durationHours < P12_CANARY_MINIMUM_HOURS) {
    throw new Error("Canary must observe at least 48 continuous hours");
  }
  const windows = array(raw.windows, "observation.windows");
  if (windows.length < P12_CANARY_MINIMUM_HOURS) {
    throw new Error("Canary requires at least 48 evidence windows");
  }
  let previousEnd = startedAt;
  windows.forEach((value, index) => {
    const window = object(value, `observation.windows[${index}]`);
    if (integer(window.sequence, `observation.windows[${index}].sequence`) !== index + 1) {
      throw new Error("Canary observation window sequence is not contiguous");
    }
    const windowStart = timestamp(window.startedAt,
      `observation.windows[${index}].startedAt`);
    const windowEnd = timestamp(window.endedAt,
      `observation.windows[${index}].endedAt`);
    if (windowStart !== previousEnd || windowEnd <= windowStart ||
        windowEnd - windowStart > HOUR_MS) {
      throw new Error("Canary observation windows must be contiguous and at most one hour");
    }
    if (window.status !== "healthy" ||
        integer(window.p0Count, `observation.windows[${index}].p0Count`) !== 0 ||
        integer(window.p1Count, `observation.windows[${index}].p1Count`) !== 0) {
      throw new Error("Canary observation contains a P0/P1 or unhealthy window");
    }
    evidenceRefs(window.evidenceRefs, `observation.windows[${index}].evidenceRefs`);
    previousEnd = windowEnd;
  });
  if (previousEnd !== endedAt) {
    throw new Error("Canary observation windows do not cover the declared end time");
  }
  return { durationHours, windowCount: windows.length };
}

function validateDefects(value: unknown): number {
  const defects = array(value, "defects");
  let p2Count = 0;
  for (const [index, value] of defects.entries()) {
    const defect = object(value, `defects[${index}]`);
    id(defect.id, `defects[${index}].id`);
    const severity = string(defect.severity, `defects[${index}].severity`);
    if (severity === "P0" || severity === "P1") {
      throw new Error("Canary cannot pass with any P0/P1 defect");
    }
    if (!new Set(["P2", "P3"]).has(severity)) {
      throw new Error(`defects[${index}].severity is invalid`);
    }
    if (severity === "P2") {
      p2Count += 1;
      id(defect.ownerId, `defects[${index}].ownerId`, true);
      string(defect.workaround, `defects[${index}].workaround`);
    }
    string(defect.status, `defects[${index}].status`);
  }
  return p2Count;
}

function validateOperationalEvents(value: unknown, label: string): void {
  const events = array(value, label);
  for (const [index, value] of events.entries()) {
    const event = object(value, `${label}[${index}]`);
    id(event.id, `${label}[${index}].id`);
    timestamp(event.observedAt, `${label}[${index}].observedAt`);
    id(event.ownerId, `${label}[${index}].ownerId`, true);
    evidenceRefs(event.evidenceRefs, `${label}[${index}].evidenceRefs`);
    if (label === "alerts") {
      const severity = string(event.severity, `${label}[${index}].severity`);
      if (severity === "P0" || severity === "P1") {
        throw new Error("Canary cannot pass with any P0/P1 alert");
      }
      if (event.resolved !== true) throw new Error("Canary alerts must be resolved");
    } else {
      string(event.reason, `${label}[${index}].reason`);
    }
  }
}

export function validateP12CanaryReport(value: unknown, options: { now?: Date } = {}): {
  durationHours: number;
  windowCount: number;
  p2Count: number;
} {
  const report = object(value, "report");
  if (report.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported canary schema");
  id(report.canaryId, "canaryId");
  if (report.status !== "passed" || report.result !== "passed") {
    throw new Error("Canary report is not passed");
  }
  const project = object(report.project, "project");
  id(project.projectId, "project.projectId", true);
  id(project.ownerId, "project.ownerId", true);
  const approvedAt = timestamp(project.approvedAt, "project.approvedAt");
  if (project.internal !== true || project.risk !== "low") {
    throw new Error("Canary project must be approved as low-risk and internal");
  }
  const scope = object(report.scope, "scope");
  id(scope.goalId, "scope.goalId", true);
  if (integer(scope.goalContractVersion, "scope.goalContractVersion") < 1) {
    throw new Error("scope.goalContractVersion must be positive");
  }
  const allowedAreas = strings(scope.allowedAreas, "scope.allowedAreas");
  const excludedAreas = new Set(strings(scope.excludedAreas, "scope.excludedAreas"));
  if (allowedAreas.some((item) => excludedAreas.has(item))) {
    throw new Error("Canary allowed and excluded scope overlap");
  }
  const conditions = object(report.conditions, "conditions");
  strings(conditions.success, "conditions.success");
  strings(conditions.stop, "conditions.stop");
  for (const key of ["rollbackRunbook", "stopRunbook"]) {
    const path = string(conditions[key], `conditions.${key}`);
    if (!path.startsWith("docs/runbooks/") || !path.endsWith(".md")) {
      throw new Error(`conditions.${key} must reference a repository Runbook`);
    }
  }

  const observation = object(report.observation, "observation");
  const result = validateObservation(observation, options.now ?? new Date());
  if (approvedAt > timestamp(observation.startedAt, "observation.startedAt")) {
    throw new Error("Canary owner approval must precede observation");
  }
  const p2Count = validateDefects(report.defects);
  validateOperationalEvents(report.alerts, "alerts");
  validateOperationalEvents(report.interventions, "interventions");
  const verification = object(report.goalVerification, "goalVerification");
  if (verification.status !== "passed") throw new Error("Goal Verification must pass");
  id(verification.verificationId, "goalVerification.verificationId", true);
  const verificationAt = timestamp(verification.completedAt, "goalVerification.completedAt");
  if (verificationAt < timestamp(observation.startedAt, "observation.startedAt") ||
      verificationAt > timestamp(observation.endedAt, "observation.endedAt")) {
    throw new Error("Goal Verification must complete during the Canary window");
  }
  evidenceRefs(verification.evidenceRefs, "goalVerification.evidenceRefs");
  if (array(report.gaps, "gaps").length !== 0) {
    throw new Error("Canary report has unresolved gaps");
  }
  return { ...result, p2Count };
}
