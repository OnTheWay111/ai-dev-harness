import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  artifactObjectLockInput,
  validateRecoveryPolicy,
  validateRecoveryProviderEvidence,
  validateRecoveryReceipt,
} from "../app/reliability/recovery-policy.ts";
import { S3ObjectStore } from
  "../app/control-plane/adapters/s3-object-store.ts";

const policyPath = new URL(
  "../../../ops/production/recovery-policy.json",
  import.meta.url,
);

test("P11 production recovery policy satisfies RPO, RTO, PITR and immutable retention", async () => {
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  validateRecoveryPolicy(policy);
  assert.equal(policy.database.pointInTimeRecovery.enabled, true);
  assert.ok(policy.database.pointInTimeRecovery.maxRecoveryPointAgeMinutes <= 15);
  assert.ok(policy.objectStore.versioning);
  assert.ok(policy.objectStore.objectLock.enabled);
  assert.equal(policy.objectStore.objectLock.mode, "COMPLIANCE");
  assert.equal(policy.artifactRetention.standard_180d, 180);
  assert.equal(policy.artifactRetention.extended_365d, 365);
  assert.equal(policy.auditRetentionDays, 180);
  assert.ok(policy.recoveryTarget.rtoMinutes <= 240);
  assert.equal(policy.recoveryTarget.networkEgress, "deny");
});

test("P11 production release rejects missing or stale provider recovery proof", () => {
  const evidence = {
    schemaVersion: "harness.recovery-provider-evidence.v1",
    environment: "production",
    observedAt: new Date().toISOString(),
    database: {
      automaticBackups: true,
      pitrEnabled: true,
      maxRecoveryPointAgeMinutes: 15,
      backupRetentionDays: 35,
      crossRegionCopy: true,
      encryptionAtRest: true,
    },
    objectStore: {
      versioning: true,
      objectLockEnabled: true,
      objectLockMode: "COMPLIANCE",
      encryptionAtRest: true,
      lifecycleConfigured: true,
    },
  };
  validateRecoveryProviderEvidence(evidence);
  assert.throws(() => validateRecoveryProviderEvidence({
    ...evidence,
    observedAt: "2026-01-01T00:00:00.000Z",
  }), /stale/i);
  assert.throws(() => validateRecoveryProviderEvidence({
    ...evidence,
    database: { ...evidence.database, pitrEnabled: false },
  }), /provider/i);
});

test("P11 S3 uploads translate application retention into Object Lock", () => {
  const standard = artifactObjectLockInput(
    "standard_180d",
    "2027-02-01T03:00:00.000Z",
  );
  assert.equal(standard.ObjectLockMode, "COMPLIANCE");
  assert.equal(standard.ObjectLockRetainUntilDate.toISOString(),
    "2027-02-01T03:00:00.000Z");
  assert.equal(standard.ObjectLockLegalHoldStatus, undefined);

  const legal = artifactObjectLockInput(
    "legal_hold",
    "2126-08-05T03:00:00.000Z",
  );
  assert.equal(legal.ObjectLockLegalHoldStatus, "ON");
});

test("P11 production S3 adapter sends COMPLIANCE retention on upload", async () => {
  let putInput;
  let headCalls = 0;
  const client = {
    async send(command) {
      if (command.constructor.name === "HeadObjectCommand") {
        headCalls += 1;
        if (headCalls === 1) {
          const error = new Error("missing");
          error.name = "NotFound";
          throw error;
        }
        return {
          ContentLength: 18,
          Metadata: { digest: putInput.Metadata.digest },
        };
      }
      if (command.constructor.name === "PutObjectCommand") {
        putInput = command.input;
        return {};
      }
      throw new Error("unexpected command");
    },
  };
  const store = new S3ObjectStore({
    client,
    bucket: "p11-recovery-test",
  });
  async function* body() {
    yield new TextEncoder().encode("immutable evidence");
  }
  await store.putImmutable({
    scope: {
      organizationId: "11000000-0000-4000-8000-000000000001",
      projectId: "11000000-0000-4000-8000-000000000002",
    },
    body: body(),
    mediaType: "text/plain",
    maxBytes: 1024,
    createdAt: "2026-08-05T03:00:00.000Z",
    createdBy: "p11-worker",
    retentionPolicy: "extended_365d",
    retentionUntil: "2027-08-05T03:00:00.000Z",
  });
  assert.equal(putInput.ObjectLockMode, "COMPLIANCE");
  assert.equal(putInput.ObjectLockRetainUntilDate.toISOString(),
    "2027-08-05T03:00:00.000Z");
  assert.equal(putInput.IfNoneMatch, "*");
});

test("P11 recovery receipt requires an isolated real restore and matching facts", () => {
  const digest = "a".repeat(64);
  const receipt = {
    schemaVersion: "harness.recovery-drill.v1",
    drillId: "p11-20260805",
    startedAt: "2026-08-05T12:00:00.000Z",
    completedAt: "2026-08-05T12:07:00.000Z",
    durationSeconds: 420,
    rpoMinutes: 15,
    rtoMinutes: 240,
    observedRecoveryPointAgeMinutes: 0.1,
    sourceDatabase: "harness_recovery_source_20260805",
    targetDatabase: "harness_recovery_target_20260805",
    isolatedTarget: true,
    backupArtifactSha256: digest,
    migrationLedgerSha256: digest,
    schemaTables: [
      "artifact_objects", "audit_events", "goals", "issues", "runs",
    ],
    entityChecks: ["goal", "issue", "run", "audit", "artifact_digest"]
      .map((entity) => ({
        entity, sourceCount: 1, targetCount: 1,
        sourceSha256: digest, targetSha256: digest, matched: true,
      })),
    artifactRetentionVerified: true,
    result: "passed",
    gaps: [],
  };
  validateRecoveryReceipt(receipt);
  assert.throws(
    () => validateRecoveryReceipt({ ...receipt, isolatedTarget: false }),
    /isolated/i,
  );
  assert.throws(
    () => validateRecoveryReceipt({
      ...receipt,
      entityChecks: receipt.entityChecks.map((item, index) =>
        index === 0 ? { ...item, targetCount: 0, matched: false } : item),
    }),
    /entity/i,
  );
});

test("P11 committed recovery drill receipt remains machine-verifiable", async () => {
  const receipt = JSON.parse(await readFile(new URL(
    "../../../docs/evidence/p11-recovery-drill-2026-08-05.json",
    import.meta.url,
  ), "utf8"));
  validateRecoveryReceipt(receipt);
  assert.equal(receipt.result, "passed");
  assert.equal(receipt.gaps.length, 0);
});
