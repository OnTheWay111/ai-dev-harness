import type { ArtifactRetentionPolicy } from
  "../control-plane/ports/object-store-port.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_DATABASE = /^harness_recovery_(?:source|target)_[a-z0-9_]{1,40}$/;
const REQUIRED_ENTITIES = new Set([
  "goal", "issue", "run", "audit", "artifact_digest",
]);
const REQUIRED_TABLES = new Set([
  "artifact_objects", "audit_events", "goals", "issues", "runs",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function numberAtMost(
  value: unknown,
  maximum: number,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) ||
    value <= 0 || value > maximum) {
    throw new Error(`${label} exceeds the production objective`);
  }
}

export function validateRecoveryPolicy(value: unknown): void {
  const policy = object(value, "Recovery policy");
  if (policy.schemaVersion !== "harness.recovery-policy.v1" ||
    policy.environment !== "production" || policy.auditRetentionDays !== 180) {
    throw new Error("Recovery policy identity or audit retention is invalid");
  }
  const database = object(policy.database, "Database recovery policy");
  const pitr = object(database.pointInTimeRecovery, "PITR policy");
  numberAtMost(pitr.maxRecoveryPointAgeMinutes, 15, "PITR RPO");
  if (pitr.enabled !== true || database.automaticBackups !== true ||
    database.encryptionAtRest !== true || database.backupRetentionDays !== 35 ||
    database.crossRegionCopy !== true) {
    throw new Error("Database backup/PITR controls are incomplete");
  }
  const store = object(policy.objectStore, "Object Store policy");
  const lock = object(store.objectLock, "Object Lock policy");
  if (store.versioning !== true || store.encryptionAtRest !== true ||
    lock.enabled !== true || lock.mode !== "COMPLIANCE") {
    throw new Error("Object Store immutability controls are incomplete");
  }
  const retention = object(policy.artifactRetention, "Artifact retention");
  if (retention.standard_180d !== 180 || retention.extended_365d !== 365 ||
    retention.legal_hold !== "indefinite-until-authorized-release") {
    throw new Error("Artifact retention mapping is invalid");
  }
  const target = object(policy.recoveryTarget, "Recovery target policy");
  numberAtMost(target.rtoMinutes, 240, "Recovery RTO");
  if (target.networkEgress !== "deny" || target.productionTraffic !== "deny" ||
    target.requireSeparateCredentials !== true ||
    target.requireRestoreReceipt !== true) {
    throw new Error("Recovery target isolation is incomplete");
  }
}

export function validateRecoveryProviderEvidence(value: unknown): void {
  const evidence = object(value, "Recovery provider evidence");
  if (evidence.schemaVersion !== "harness.recovery-provider-evidence.v1" ||
    evidence.environment !== "production" || !iso(evidence.observedAt) ||
    Date.now() - Date.parse(evidence.observedAt) > 24 * 60 * 60 * 1_000) {
    throw new Error("Recovery provider evidence is missing, stale, or invalid");
  }
  const database = object(evidence.database, "Database provider evidence");
  numberAtMost(database.maxRecoveryPointAgeMinutes, 15, "Provider PITR RPO");
  if (database.automaticBackups !== true || database.pitrEnabled !== true ||
    database.backupRetentionDays !== 35 || database.crossRegionCopy !== true ||
    database.encryptionAtRest !== true) {
    throw new Error("Database provider evidence does not satisfy recovery policy");
  }
  const store = object(evidence.objectStore, "Object provider evidence");
  if (store.versioning !== true || store.objectLockEnabled !== true ||
    store.objectLockMode !== "COMPLIANCE" || store.encryptionAtRest !== true ||
    store.lifecycleConfigured !== true) {
    throw new Error("Object provider evidence does not satisfy retention policy");
  }
}

export function artifactObjectLockInput(
  policy: ArtifactRetentionPolicy,
  retentionUntil: string,
): {
  ObjectLockMode: "COMPLIANCE";
  ObjectLockRetainUntilDate: Date;
  ObjectLockLegalHoldStatus?: "ON";
} {
  const date = new Date(retentionUntil);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Artifact Object Lock retention time is invalid");
  }
  return {
    ObjectLockMode: "COMPLIANCE",
    ObjectLockRetainUntilDate: date,
    ...(policy === "legal_hold" ? { ObjectLockLegalHoldStatus: "ON" as const } : {}),
  };
}

export interface RecoveryEntityCheck {
  entity: string;
  sourceCount: number;
  targetCount: number;
  sourceSha256: string;
  targetSha256: string;
  matched: boolean;
}

export interface RecoveryDrillReceipt {
  schemaVersion: "harness.recovery-drill.v1";
  drillId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  rpoMinutes: 15;
  rtoMinutes: 240;
  observedRecoveryPointAgeMinutes: number;
  sourceDatabase: string;
  targetDatabase: string;
  isolatedTarget: true;
  backupArtifactSha256: string;
  migrationLedgerSha256: string;
  schemaTables: string[];
  entityChecks: RecoveryEntityCheck[];
  artifactRetentionVerified: true;
  result: "passed";
  gaps: string[];
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validateRecoveryReceipt(
  value: unknown,
): asserts value is RecoveryDrillReceipt {
  const receipt = object(value, "Recovery receipt");
  if (receipt.schemaVersion !== "harness.recovery-drill.v1" ||
    typeof receipt.drillId !== "string" || !/^[a-z0-9-]{8,80}$/.test(receipt.drillId) ||
    !iso(receipt.startedAt) || !iso(receipt.completedAt) ||
    typeof receipt.durationSeconds !== "number" || receipt.durationSeconds < 0 ||
    receipt.rpoMinutes !== 15 || receipt.rtoMinutes !== 240 ||
    typeof receipt.observedRecoveryPointAgeMinutes !== "number" ||
    receipt.observedRecoveryPointAgeMinutes < 0 ||
    receipt.observedRecoveryPointAgeMinutes > 15 ||
    receipt.durationSeconds > 240 * 60 || receipt.isolatedTarget !== true ||
    receipt.result !== "passed") {
    throw new Error("Recovery receipt does not prove isolated RPO/RTO recovery");
  }
  if (!SAFE_DATABASE.test(String(receipt.sourceDatabase)) ||
    !SAFE_DATABASE.test(String(receipt.targetDatabase)) ||
    receipt.sourceDatabase === receipt.targetDatabase) {
    throw new Error("Recovery receipt isolated databases are invalid");
  }
  if (!SHA256.test(String(receipt.backupArtifactSha256)) ||
    !SHA256.test(String(receipt.migrationLedgerSha256))) {
    throw new Error("Recovery receipt backup digests are invalid");
  }
  const schemaTables = receipt.schemaTables;
  if (!Array.isArray(schemaTables) ||
    [...REQUIRED_TABLES].some((table) => !schemaTables.includes(table))) {
    throw new Error("Recovery receipt schema verification is incomplete");
  }
  const entityChecks = receipt.entityChecks;
  if (!Array.isArray(entityChecks) ||
    entityChecks.length !== REQUIRED_ENTITIES.size) {
    throw new Error("Recovery receipt entity verification is incomplete");
  }
  const entities = new Set<string>();
  for (const raw of entityChecks) {
    const check = object(raw, "Recovery entity check");
    const entity = String(check.entity);
    entities.add(entity);
    if (!REQUIRED_ENTITIES.has(entity) ||
      !Number.isSafeInteger(check.sourceCount) || Number(check.sourceCount) < 1 ||
      check.sourceCount !== check.targetCount || check.matched !== true ||
      !SHA256.test(String(check.sourceSha256)) ||
      check.sourceSha256 !== check.targetSha256) {
      throw new Error("Recovery receipt entity facts do not match");
    }
  }
  if (entities.size !== REQUIRED_ENTITIES.size ||
    receipt.artifactRetentionVerified !== true ||
    !Array.isArray(receipt.gaps) ||
    receipt.gaps.some((gap) => typeof gap !== "string")) {
    throw new Error("Recovery receipt entity or Artifact verification is incomplete");
  }
}
