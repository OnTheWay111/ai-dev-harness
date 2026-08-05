import assert from "node:assert/strict";
import test from "node:test";

import {
  releaseAttestationDigest,
  validateP12ProductionReleaseGate,
} from "../app/reliability/p12-production-release-gate.ts";

const HOUR = 60 * 60 * 1000;
const START = Date.parse("2026-08-05T00:00:00.000Z");
const NOW = new Date(START + 51 * HOUR);
const ROLES = ["security", "operations", "product", "project-owner"];
const GATES = [
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
];

function canary() {
  return {
    schemaVersion: "harness.p12-canary-report.v1",
    canaryId: "p12-canary-internal-01",
    status: "passed",
    project: {
      projectId: "internal-low-risk-project",
      internal: true,
      risk: "low",
      ownerId: "canary-owner-01",
      approvedAt: "2026-08-04T23:30:00.000Z",
    },
    scope: {
      goalId: "goal-canary-01",
      goalContractVersion: 3,
      allowedAreas: ["documentation"],
      excludedAreas: ["production-data"],
    },
    conditions: {
      success: ["Goal Verification passed"],
      stop: ["Any P0/P1"],
      rollbackRunbook: "docs/runbooks/deployment-rollback-upgrade.md",
      stopRunbook: "docs/runbooks/execution-stop-worker-loss.md",
    },
    observation: {
      requiredDurationHours: 48,
      startedAt: new Date(START).toISOString(),
      endedAt: new Date(START + 48 * HOUR).toISOString(),
      windows: Array.from({ length: 48 }, (_, index) => ({
        sequence: index + 1,
        startedAt: new Date(START + index * HOUR).toISOString(),
        endedAt: new Date(START + (index + 1) * HOUR).toISOString(),
        status: "healthy",
        p0Count: 0,
        p1Count: 0,
        evidenceRefs: [`metric-window:${index + 1}`],
      })),
    },
    defects: [],
    alerts: [],
    interventions: [],
    goalVerification: {
      status: "passed",
      verificationId: "verification-canary-01",
      completedAt: new Date(START + 47 * HOUR).toISOString(),
      evidenceRefs: ["artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    },
    gaps: [],
    result: "passed",
  };
}

function unsignedRelease() {
  return {
    schemaVersion: "harness.p12-production-release-gate.v1",
    releaseId: "production-v1-20260807-01",
    target: "production-v1",
    candidateCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    evaluatedAt: new Date(START + 49 * HOUR).toISOString(),
    canary: canary(),
    gates: GATES.map((gateId, index) => ({
      gateId,
      status: "passed",
      ownerRole: index % 2 === 0 ? "security" : "operations",
      checkedAt: new Date(START + (48 * HOUR) + index * 60_000).toISOString(),
      evidenceRefs: [`gate-receipt:${gateId}`],
    })),
    defects: {
      p0Count: 0,
      p1Count: 0,
      p2: [{
        id: "P2-001",
        ownerId: "p2-owner-01",
        workaround: "Use the documented bounded retry.",
        evidenceRefs: ["defect-receipt:P2-001"],
      }],
    },
    signatures: [],
    gaps: [],
    result: "approved",
  };
}

function release() {
  const value = unsignedRelease();
  const digest = releaseAttestationDigest(value);
  value.signatures = ROLES.map((role, index) => ({
    role,
    signerId: `${role}-owner-01`,
    signedAt: new Date(START + 50 * HOUR + index * 60_000).toISOString(),
    decision: "approved",
    reason: `Approved ${role} Production V1 gate after evidence review.`,
    authenticationMethod: "oidc",
    requestId: `release-sign-${role}-01`,
    auditReceiptId: `audit-release-${role}-01`,
    attestationDigest: digest,
  }));
  return value;
}

test("accepts all Production V1 gates and four digest-bound OIDC signatures", () => {
  const result = validateP12ProductionReleaseGate(release(), { now: NOW });
  assert.equal(result.gateCount, 10);
  assert.equal(result.signatureCount, 4);
  assert.match(result.attestationDigest, /^[0-9a-f]{64}$/);
});

test("rejects missing gates and failed Canary evidence", () => {
  const missing = release();
  missing.gates.pop();
  assert.throws(() => validateP12ProductionReleaseGate(missing, { now: NOW }), /gates/);
  const failedCanary = release();
  failedCanary.canary.goalVerification.status = "failed";
  assert.throws(
    () => validateP12ProductionReleaseGate(failedCanary, { now: NOW }),
    /Goal Verification/,
  );
});

test("rejects P0/P1 and ownerless P2 defects", () => {
  const p1 = release();
  p1.defects.p1Count = 1;
  assert.throws(() => validateP12ProductionReleaseGate(p1, { now: NOW }), /P0\/P1/);
  const ownerless = release();
  ownerless.defects.p2[0].ownerId = "";
  assert.throws(() => validateP12ProductionReleaseGate(ownerless, { now: NOW }), /ownerId/);
});

test("rejects missing, placeholder, future, or unbound signatures", () => {
  const missing = release();
  missing.signatures.pop();
  assert.throws(() => validateP12ProductionReleaseGate(missing, { now: NOW }), /signatures/);
  const placeholder = release();
  placeholder.signatures[0].signerId = "test-user";
  assert.throws(() => validateP12ProductionReleaseGate(placeholder, { now: NOW }), /signer/);
  const future = release();
  future.signatures[0].signedAt = new Date(START + 52 * HOUR).toISOString();
  assert.throws(() => validateP12ProductionReleaseGate(future, { now: NOW }), /future/);
  const unbound = release();
  unbound.signatures[0].attestationDigest = "c".repeat(64);
  assert.throws(() => validateP12ProductionReleaseGate(unbound, { now: NOW }), /digest/);
});
