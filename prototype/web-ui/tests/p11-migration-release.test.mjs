import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateMigrationGate,
  validateMigrationDrillReceipt,
  validateMigrationPolicy,
} from "../app/reliability/migration-release.ts";

test("P11 migration policy requires expand/migrate/contract and rollback safety", async () => {
  const policy = JSON.parse(await readFile(new URL(
    "../../../ops/production/migration-policy.json",
    import.meta.url,
  ), "utf8"));
  validateMigrationPolicy(policy);
  assert.deepEqual(policy.phases, ["expand", "migrate", "contract"]);
  assert.ok(policy.minimumCompatibilityHours >= 24);
  assert.equal(policy.runningRuns.defaultAction, "drain");
  assert.equal(policy.contract.requireZeroPreviousVersionInstances, true);
  assert.equal(policy.contract.requireIrreversibleApproval, true);
  assert.equal(policy.rollback.previousArtifactRetentionHours, 168);
});

const base = {
  migrationId: "p11-payload-v2",
  phase: "contract",
  now: "2026-08-05T12:00:00.000Z",
  statements: ["ALTER TABLE p11_items DROP COLUMN payload_v1"],
  expandApplied: true,
  dualReadWriteVerified: true,
  idempotentBackfill: true,
  backfillComplete: true,
  remainingRows: 0,
  verificationDigest: "a".repeat(64),
  compatibilityWindowEndsAt: "2026-08-05T11:00:00.000Z",
  previousAppVersion: "v1.0.0",
  candidateAppVersion: "v1.1.0",
  activeAppVersions: ["v1.1.0"],
  previousAppRollbackVerified: true,
  incompatibleRunningRuns: 0,
  backupReceiptId: "recovery-receipt-p11",
  backupAgeMinutes: 5,
  approval: {
    migrationId: "p11-payload-v2",
    decision: "approved",
    actorRole: "production-migration-approver",
    irreversible: true,
    expiresAt: "2026-08-05T13:00:00.000Z",
  },
};

test("P11 expand gate rejects destructive or compatibility-breaking DDL", () => {
  const accepted = evaluateMigrationGate({
    ...base,
    phase: "expand",
    statements: [
      "ALTER TABLE p11_items ADD COLUMN payload_v2 jsonb",
      "CREATE INDEX CONCURRENTLY p11_items_payload_v2_idx ON p11_items ((payload_v2->>'id'))",
    ],
  });
  assert.equal(accepted.allowed, true);
  for (const statement of [
    "DROP TABLE p11_items",
    "ALTER TABLE p11_items DROP COLUMN payload_v1",
    "ALTER TABLE p11_items ALTER COLUMN payload_v2 SET NOT NULL",
    "ALTER TABLE p11_items RENAME COLUMN payload_v1 TO payload",
  ]) {
    const result = evaluateMigrationGate({
      ...base, phase: "expand", statements: [statement],
    });
    assert.equal(result.allowed, false, statement);
  }
});

test("P11 contract gate waits for backfill, old versions, Runs, backup and approval", () => {
  assert.deepEqual(evaluateMigrationGate(base), { allowed: true, reasons: [] });
  const scenarios = [
    { activeAppVersions: ["v1.0.0", "v1.1.0"] },
    { incompatibleRunningRuns: 1 },
    { remainingRows: 1, backfillComplete: false },
    { backupAgeMinutes: 16 },
    { previousAppRollbackVerified: false },
    { approval: undefined },
    { compatibilityWindowEndsAt: "2026-08-05T13:00:00.000Z" },
  ];
  for (const override of scenarios) {
    const result = evaluateMigrationGate({ ...base, ...override });
    assert.equal(result.allowed, false, JSON.stringify(override));
    assert.ok(result.reasons.length > 0);
  }
});

test("P11 migrate gate requires verified idempotent dual-version backfill", () => {
  assert.equal(evaluateMigrationGate({
    ...base, phase: "migrate", statements: [],
  }).allowed, true);
  assert.equal(evaluateMigrationGate({
    ...base, phase: "migrate", statements: [], idempotentBackfill: false,
  }).allowed, false);
  assert.equal(evaluateMigrationGate({
    ...base, phase: "migrate", statements: [], dualReadWriteVerified: false,
  }).allowed, false);
});

test("P11 migration drill receipt proves real forward migration and app rollback", () => {
  const receipt = {
    schemaVersion: "harness.migration-rollback-drill.v1",
    drillId: "p11-migration-20260805",
    migrationId: "p11-payload-v2",
    startedAt: "2026-08-05T12:00:00.000Z",
    completedAt: "2026-08-05T12:01:00.000Z",
    durationSeconds: 60,
    database: "harness_recovery_source_20260805b",
    table: "p11_migration_drill_20260805",
    phases: ["expand", "migrate", "app_rollback"].map((phase) => ({
      phase, result: "passed", statementsSha256: "b".repeat(64),
    })),
    previousAppVersion: "v1",
    candidateAppVersion: "v2",
    facts: {
      baselineRows: 1,
      afterCandidateRows: 2,
      afterBackfillRows: 3,
      remainingNulls: 0,
      oldAppReadAfterExpand: true,
      oldAppReadCandidateRows: true,
      oldAppWriteAfterExpand: true,
      newAppReadAfterRollback: true,
      contractBlockedWithOldVersion: true,
    },
    noDestructiveReset: true,
    result: "passed",
    gaps: [],
  };
  validateMigrationDrillReceipt(receipt);
  assert.throws(() => validateMigrationDrillReceipt({
    ...receipt, facts: { ...receipt.facts, remainingNulls: 1 },
  }), /facts/i);
});

test("P11 committed migration rollback receipt remains machine-verifiable", async () => {
  const receipt = JSON.parse(await readFile(new URL(
    "../../../docs/evidence/p11-migration-rollback-drill-2026-08-05.json",
    import.meta.url,
  ), "utf8"));
  validateMigrationDrillReceipt(receipt);
  assert.equal(receipt.result, "passed");
  assert.equal(receipt.gaps.length, 0);
});
