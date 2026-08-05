import { createHash } from "node:crypto";

import { validateP12CanaryReport } from "./p12-canary-gate.ts";

const SCHEMA_VERSION = "harness.p12-production-release-gate.v1";
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const PLACEHOLDER = /(?:^|[-_.])(test|example|placeholder|unknown|tbd|todo)(?:$|[-_.])/i;
export const P12_PRODUCTION_GATE_IDS = [
  "browser-e2e",
  "identity-security",
  "autodev-authorization",
  "model-routing-write",
  "supply-chain",
  "git-traceability",
  "recovery-stop",
  "observability-oncall",
  "canary-goal-verification",
  "defect-budget",
] as const;
export const P12_RELEASE_SIGNATURE_ROLES = [
  "security",
  "operations",
  "product",
  "project-owner",
] as const;

type ObjectValue = Record<string, unknown>;

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as ObjectValue;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function id(value: unknown, label: string, rejectPlaceholder = false): string {
  const text = string(value, label);
  if (!SAFE_ID.test(text) || (rejectPlaceholder && PLACEHOLDER.test(text))) {
    throw new Error(`${label} is not a real signer or receipt identity`);
  }
  return text;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
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

function evidenceRefs(value: unknown, label: string): void {
  const refs = array(value, label);
  if (refs.length === 0 || refs.some((item) => typeof item !== "string" ||
    !/^[a-z][a-z0-9-]*:[A-Za-z0-9._:-]+$/.test(item))) {
    throw new Error(`${label} must contain versioned evidence references`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as ObjectValue)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function releaseAttestationDigest(value: unknown): string {
  const release = object(value, "release");
  const attested = Object.fromEntries(
    Object.entries(release).filter(([key]) => key !== "signatures"),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(attested)))
    .digest("hex");
}

function validateGates(value: unknown, canaryEnd: number, evaluatedAt: number): number {
  const gates = array(value, "gates");
  if (gates.length !== P12_PRODUCTION_GATE_IDS.length) {
    throw new Error("Production V1 gates are incomplete");
  }
  const seen = new Set<string>();
  for (const [index, value] of gates.entries()) {
    const gate = object(value, `gates[${index}]`);
    const gateId = string(gate.gateId, `gates[${index}].gateId`);
    if (!P12_PRODUCTION_GATE_IDS.includes(
      gateId as typeof P12_PRODUCTION_GATE_IDS[number]) || seen.has(gateId)) {
      throw new Error("Production V1 gates contain an unknown or duplicate gate");
    }
    seen.add(gateId);
    if (gate.status !== "passed") throw new Error(`gate ${gateId} is not passed`);
    if (!P12_RELEASE_SIGNATURE_ROLES.includes(
      string(gate.ownerRole, `gates[${index}].ownerRole`) as typeof P12_RELEASE_SIGNATURE_ROLES[number])) {
      throw new Error(`gate ${gateId} has an invalid owner role`);
    }
    const checkedAt = timestamp(gate.checkedAt, `gates[${index}].checkedAt`);
    if (checkedAt < canaryEnd || checkedAt > evaluatedAt) {
      throw new Error(`gate ${gateId} was checked outside the final evidence window`);
    }
    evidenceRefs(gate.evidenceRefs, `gates[${index}].evidenceRefs`);
  }
  if (P12_PRODUCTION_GATE_IDS.some((gate) => !seen.has(gate))) {
    throw new Error("Production V1 gates are incomplete");
  }
  return gates.length;
}

function validateDefects(value: unknown): void {
  const defects = object(value, "defects");
  if (integer(defects.p0Count, "defects.p0Count") !== 0 ||
      integer(defects.p1Count, "defects.p1Count") !== 0) {
    throw new Error("Production V1 cannot release with P0/P1 defects");
  }
  for (const [index, value] of array(defects.p2, "defects.p2").entries()) {
    const defect = object(value, `defects.p2[${index}]`);
    id(defect.id, `defects.p2[${index}].id`);
    id(defect.ownerId, `defects.p2[${index}].ownerId`);
    string(defect.workaround, `defects.p2[${index}].workaround`);
    evidenceRefs(defect.evidenceRefs, `defects.p2[${index}].evidenceRefs`);
  }
}

function validateSignatures(
  value: unknown,
  attestationDigest: string,
  evaluatedAt: number,
  now: Date,
): number {
  const signatures = array(value, "signatures");
  if (signatures.length !== P12_RELEASE_SIGNATURE_ROLES.length) {
    throw new Error("Production V1 requires exactly four role signatures");
  }
  const seenRoles = new Set<string>();
  const seenSigners = new Set<string>();
  for (const [index, value] of signatures.entries()) {
    const signature = object(value, `signatures[${index}]`);
    const role = string(signature.role, `signatures[${index}].role`);
    if (!P12_RELEASE_SIGNATURE_ROLES.includes(
      role as typeof P12_RELEASE_SIGNATURE_ROLES[number]) ||
        seenRoles.has(role)) {
      throw new Error("Production V1 signatures have a missing or duplicate role");
    }
    const signer = id(signature.signerId, `signatures[${index}].signerId`, true);
    if (seenSigners.has(signer)) {
      throw new Error("Each Production V1 role must have a distinct signer");
    }
    seenRoles.add(role);
    seenSigners.add(signer);
    const signedAt = timestamp(signature.signedAt, `signatures[${index}].signedAt`);
    if (signedAt < evaluatedAt) throw new Error("signature predates final gate evaluation");
    if (signedAt > now.getTime()) throw new Error("signature timestamp is in the future");
    if (signature.decision !== "approved" || signature.authenticationMethod !== "oidc") {
      throw new Error("signature must be an approved OIDC attestation");
    }
    if (string(signature.reason, `signatures[${index}].reason`).length < 20) {
      throw new Error("signature reason is too short");
    }
    id(signature.requestId, `signatures[${index}].requestId`, true);
    id(signature.auditReceiptId, `signatures[${index}].auditReceiptId`, true);
    const digest = string(signature.attestationDigest,
      `signatures[${index}].attestationDigest`);
    if (!DIGEST.test(digest) || digest !== attestationDigest) {
      throw new Error("signature digest does not bind the final release evidence");
    }
  }
  return signatures.length;
}

export function validateP12ProductionReleaseGate(
  value: unknown,
  options: { now?: Date } = {},
): { gateCount: number; signatureCount: number; attestationDigest: string } {
  const now = options.now ?? new Date();
  const release = object(value, "release");
  if (release.schemaVersion !== SCHEMA_VERSION || release.target !== "production-v1") {
    throw new Error("release schema or target is invalid");
  }
  id(release.releaseId, "releaseId");
  if (!COMMIT_SHA.test(string(release.candidateCommit, "candidateCommit"))) {
    throw new Error("candidateCommit must be a full Git SHA");
  }
  const evaluatedAt = timestamp(release.evaluatedAt, "evaluatedAt");
  if (evaluatedAt > now.getTime()) throw new Error("release evaluation is in the future");
  const canary = object(release.canary, "canary");
  validateP12CanaryReport(canary, { now });
  const canaryEnd = timestamp(object(canary.observation,
    "canary.observation").endedAt, "canary.observation.endedAt");
  if (evaluatedAt < canaryEnd) throw new Error("release was evaluated before Canary ended");
  const gateCount = validateGates(release.gates, canaryEnd, evaluatedAt);
  validateDefects(release.defects);
  if (array(release.gaps, "gaps").length !== 0 || release.result !== "approved") {
    throw new Error("release has unresolved gaps or is not approved");
  }
  const attestationDigest = releaseAttestationDigest(release);
  const signatureCount = validateSignatures(
    release.signatures,
    attestationDigest,
    evaluatedAt,
    now,
  );
  return { gateCount, signatureCount, attestationDigest };
}
