const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-z][a-z0-9-]{2,79}$/;
const SAFE_DATABASE = /^harness_recovery_(?:source|target)_[a-z0-9_]{1,40}$/;
const SAFE_DRILL_TABLE = /^p11_migration_drill_[a-z0-9_]{1,40}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validateMigrationPolicy(value: unknown): void {
  const policy = object(value, "Migration policy");
  if (policy.schemaVersion !== "harness.migration-policy.v1" ||
    policy.environment !== "production" ||
    JSON.stringify(policy.phases) !== JSON.stringify([
      "expand", "migrate", "contract",
    ]) || typeof policy.minimumCompatibilityHours !== "number" ||
    policy.minimumCompatibilityHours < 24) {
    throw new Error("Migration policy identity or compatibility window is invalid");
  }
  const runs = object(policy.runningRuns, "Running Run policy");
  const contract = object(policy.contract, "Contract policy");
  const rollback = object(policy.rollback, "Rollback policy");
  if (runs.defaultAction !== "drain" || runs.allowForcedTermination !== false ||
    contract.requireZeroPreviousVersionInstances !== true ||
    contract.requireZeroIncompatibleRuns !== true ||
    contract.requireIrreversibleApproval !== true ||
    contract.requireFreshBackupMinutes !== 15 ||
    rollback.requirePreviousAppVerification !== true ||
    rollback.previousArtifactRetentionHours !== 168) {
    throw new Error("Migration contract, Run drain, or rollback controls are incomplete");
  }
}

function expandCompatible(statement: string): boolean {
  const normalized = statement.trim().replace(/;$/, "").replace(/\s+/g, " ");
  if (!normalized || normalized.includes(";") || /--|\/\*/.test(normalized)) {
    return false;
  }
  const upper = normalized.toUpperCase();
  if (/\b(DROP|TRUNCATE|RENAME|SET NOT NULL|ALTER TYPE|USING)\b/.test(upper)) {
    return false;
  }
  if (/^ALTER TABLE [A-Z0-9_."]+ ADD COLUMN /.test(upper)) {
    return !/\bNOT NULL\b/.test(upper);
  }
  if (/^ALTER TABLE [A-Z0-9_."]+ ADD CONSTRAINT .+ NOT VALID$/.test(upper)) {
    return true;
  }
  return /^CREATE (TABLE|TYPE) /.test(upper) ||
    /^CREATE (UNIQUE )?INDEX CONCURRENTLY /.test(upper);
}

export interface MigrationGateInput {
  migrationId: string;
  phase: "expand" | "migrate" | "contract";
  now: string;
  statements: readonly string[];
  expandApplied: boolean;
  dualReadWriteVerified: boolean;
  idempotentBackfill: boolean;
  backfillComplete: boolean;
  remainingRows: number;
  verificationDigest: string;
  compatibilityWindowEndsAt: string;
  previousAppVersion: string;
  candidateAppVersion: string;
  activeAppVersions: readonly string[];
  previousAppRollbackVerified: boolean;
  incompatibleRunningRuns: number;
  backupReceiptId: string;
  backupAgeMinutes: number;
  approval?: {
    migrationId: string;
    decision: "approved" | "rejected";
    actorRole: string;
    irreversible: boolean;
    expiresAt: string;
  };
}

export interface MigrationGateResult {
  allowed: boolean;
  reasons: string[];
}

export function evaluateMigrationGate(
  input: MigrationGateInput,
): MigrationGateResult {
  const reasons: string[] = [];
  const now = Date.parse(input.now);
  if (!SAFE_ID.test(input.migrationId) || !Number.isFinite(now)) {
    reasons.push("migration identity or observation time is invalid");
  }
  if (input.phase === "expand") {
    if (input.statements.length === 0 ||
      input.statements.some((statement) => !expandCompatible(statement))) {
      reasons.push("expand contains destructive or compatibility-breaking DDL");
    }
    return { allowed: reasons.length === 0, reasons };
  }
  if (!input.expandApplied) reasons.push("expand is not applied");
  if (!input.dualReadWriteVerified) {
    reasons.push("dual-version reads and writes are not verified");
  }
  if (!input.idempotentBackfill) reasons.push("backfill is not idempotent");
  if (!SHA256.test(input.verificationDigest)) {
    reasons.push("backfill verification digest is invalid");
  }
  if (input.phase === "migrate") {
    return { allowed: reasons.length === 0, reasons };
  }
  if (!input.backfillComplete || input.remainingRows !== 0) {
    reasons.push("backfill is incomplete");
  }
  if (!iso(input.compatibilityWindowEndsAt) ||
    Date.parse(input.compatibilityWindowEndsAt) > now) {
    reasons.push("compatibility window is still active");
  }
  if (input.activeAppVersions.includes(input.previousAppVersion) ||
    !input.activeAppVersions.includes(input.candidateAppVersion)) {
    reasons.push("previous application version is still active");
  }
  if (!Number.isSafeInteger(input.incompatibleRunningRuns) ||
    input.incompatibleRunningRuns !== 0) {
    reasons.push("incompatible running Runs are not drained");
  }
  if (!input.previousAppRollbackVerified) {
    reasons.push("previous application rollback was not verified");
  }
  if (!input.backupReceiptId.trim() || !Number.isFinite(input.backupAgeMinutes) ||
    input.backupAgeMinutes < 0 || input.backupAgeMinutes > 15) {
    reasons.push("fresh database backup receipt is missing");
  }
  const approval = input.approval;
  if (!approval || approval.migrationId !== input.migrationId ||
    approval.decision !== "approved" ||
    approval.actorRole !== "production-migration-approver" ||
    approval.irreversible !== true || !iso(approval.expiresAt) ||
    Date.parse(approval.expiresAt) <= now) {
    reasons.push("valid irreversible migration approval is missing");
  }
  return { allowed: reasons.length === 0, reasons };
}

export interface MigrationDrillReceipt {
  schemaVersion: "harness.migration-rollback-drill.v1";
  drillId: string;
  migrationId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  database: string;
  table: string;
  phases: Array<{
    phase: "expand" | "migrate" | "app_rollback";
    result: "passed";
    statementsSha256: string;
  }>;
  previousAppVersion: "v1";
  candidateAppVersion: "v2";
  facts: {
    baselineRows: number;
    afterCandidateRows: number;
    afterBackfillRows: number;
    remainingNulls: 0;
    oldAppReadAfterExpand: true;
    oldAppReadCandidateRows: true;
    oldAppWriteAfterExpand: true;
    newAppReadAfterRollback: true;
    contractBlockedWithOldVersion: true;
  };
  noDestructiveReset: true;
  result: "passed";
  gaps: string[];
}

export function validateMigrationDrillReceipt(
  value: unknown,
): asserts value is MigrationDrillReceipt {
  const receipt = object(value, "Migration drill receipt");
  if (receipt.schemaVersion !== "harness.migration-rollback-drill.v1" ||
    typeof receipt.drillId !== "string" || !SAFE_ID.test(receipt.drillId) ||
    typeof receipt.migrationId !== "string" || !SAFE_ID.test(receipt.migrationId) ||
    !iso(receipt.startedAt) || !iso(receipt.completedAt) ||
    typeof receipt.durationSeconds !== "number" || receipt.durationSeconds < 0 ||
    !SAFE_DATABASE.test(String(receipt.database)) ||
    !SAFE_DRILL_TABLE.test(String(receipt.table)) ||
    receipt.previousAppVersion !== "v1" || receipt.candidateAppVersion !== "v2" ||
    receipt.noDestructiveReset !== true || receipt.result !== "passed" ||
    !Array.isArray(receipt.gaps)) {
    throw new Error("Migration drill receipt identity or result is invalid");
  }
  const phases = receipt.phases;
  if (!Array.isArray(phases) || phases.length !== 3 ||
    phases.map((raw) => object(raw, "Migration drill phase").phase).join(",") !==
      "expand,migrate,app_rollback" ||
    phases.some((raw) => {
      const phase = object(raw, "Migration drill phase");
      return phase.result !== "passed" || !SHA256.test(String(phase.statementsSha256));
    })) {
    throw new Error("Migration drill phases are incomplete");
  }
  const facts = object(receipt.facts, "Migration drill facts");
  if (!Number.isSafeInteger(facts.baselineRows) || Number(facts.baselineRows) < 1 ||
    !Number.isSafeInteger(facts.afterCandidateRows) ||
    Number(facts.afterCandidateRows) <= Number(facts.baselineRows) ||
    !Number.isSafeInteger(facts.afterBackfillRows) ||
    Number(facts.afterBackfillRows) <= Number(facts.afterCandidateRows) ||
    facts.remainingNulls !== 0 || facts.oldAppReadAfterExpand !== true ||
    facts.oldAppReadCandidateRows !== true || facts.oldAppWriteAfterExpand !== true ||
    facts.newAppReadAfterRollback !== true ||
    facts.contractBlockedWithOldVersion !== true) {
    throw new Error("Migration drill facts do not prove compatibility and rollback");
  }
}
