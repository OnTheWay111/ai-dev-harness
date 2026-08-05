import assert from "node:assert/strict";
import test from "node:test";

import {
  approveCanary,
  createCanary,
  createProductionRelease,
  evaluateProductionRelease,
  finalizeCanary,
  recordCanaryEvent,
  recordCanaryWindow,
  recordProductionGate,
  restartCanary,
  signProductionRelease,
} from "../app/release-center/domain.ts";

const HOUR = 60 * 60 * 1_000;
const START = new Date("2026-08-05T00:00:00.000Z");
const ids = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
  canaryId: "00000000-0000-4000-8000-000000000004",
  releaseId: "00000000-0000-4000-8000-000000000005",
};

function draft() {
  return {
    ...ids,
    candidateCommit: "a".repeat(40),
    goalContractVersion: 3,
    allowedAreas: ["documentation", "non-production-tooling"],
    excludedAreas: ["production-data", "credentials", "billing"],
    successConditions: ["Goal Verification passed", "No P0/P1 for 12 hours"],
    stopConditions: ["Any P0/P1", "owner requests Stop"],
    rollbackRunbook: "docs/runbooks/deployment-rollback-upgrade.md",
    stopRunbook: "docs/runbooks/execution-stop-worker-loss.md",
    createdBy: "oidc_operator",
    now: START,
  };
}

function approvedCanary() {
  return approveCanary(createCanary(draft()), {
    actorId: "oidc_project_owner",
    reason: "Approve bounded internal low-risk Canary execution",
    now: START,
  });
}

function healthyWindow(index) {
  return {
    sequence: index + 1,
    startedAt: new Date(START.getTime() + index * HOUR).toISOString(),
    endedAt: new Date(START.getTime() + (index + 1) * HOUR).toISOString(),
    status: "healthy",
    p0Count: 0,
    p1Count: 0,
    evidenceRefs: [`metric-window:${String(index + 1).padStart(2, "0")}`],
  };
}

function passedCanary() {
  let canary = approvedCanary();
  for (let index = 0; index < 12; index += 1) {
    canary = recordCanaryWindow(canary, {
      actorId: "oidc_operations",
      window: healthyWindow(index),
      now: new Date(START.getTime() + (index + 1) * HOUR),
    });
  }
  canary = recordCanaryEvent(canary, {
    actorId: "oidc_operations",
    event: {
      id: "P2-001",
      kind: "defect",
      severity: "P2",
      observedAt: new Date(START.getTime() + 2 * HOUR).toISOString(),
      ownerId: "p2-owner-01",
      workaround: "Use the bounded manual retry Runbook.",
      status: "mitigated",
      evidenceRefs: ["defect-receipt:P2-001"],
    },
    now: new Date(START.getTime() + 12 * HOUR),
  });
  return finalizeCanary(canary, {
    verification: {
      id: "verification-canary-01",
      verdict: "passed",
      verifiedAt: new Date(START.getTime() + 11 * HOUR).toISOString(),
      evidenceRefs: ["goal-verification:verification-canary-01"],
    },
    now: new Date(START.getTime() + 13 * HOUR),
  });
}

test("Canary freezes approved scope and records a continuous observation", () => {
  let canary = approvedCanary();
  assert.equal(canary.status, "observing");
  assert.equal(canary.ownerId, "oidc_project_owner");
  canary = recordCanaryWindow(canary, {
    actorId: "oidc_operations",
    window: healthyWindow(0),
    now: new Date(START.getTime() + HOUR),
  });
  assert.equal(canary.windows.length, 1);
  assert.equal(canary.version, 3);

  assert.throws(() => recordCanaryWindow(canary, {
    actorId: "oidc_operations",
    window: { ...healthyWindow(1), startedAt: new Date(START.getTime() + 3 * HOUR).toISOString() },
    now: new Date(START.getTime() + 4 * HOUR),
  }), /contiguous/);
});

test("P0/P1 stops the attempt and restart preserves prior evidence", () => {
  let canary = approvedCanary();
  canary = recordCanaryEvent(canary, {
    actorId: "oidc_operations",
    event: {
      id: "alert-critical-01",
      kind: "alert",
      severity: "P1",
      observedAt: new Date(START.getTime() + 10_000).toISOString(),
      ownerId: "oncall-owner-01",
      resolved: false,
      evidenceRefs: ["alert-receipt:critical-01"],
    },
    now: new Date(START.getTime() + 10_000),
  });
  assert.equal(canary.status, "stopped");
  const restarted = restartCanary(canary, {
    actorId: "oidc_project_owner",
    reason: "P1 was fixed and the owner re-approved a fresh observation",
    now: new Date(START.getTime() + HOUR),
  });
  assert.equal(restarted.attempt, 2);
  assert.equal(restarted.status, "observing");
  assert.equal(restarted.events.length, 1);
});

test("Canary cannot finalize early and emits the authoritative P12 report after 12 hours", () => {
  let canary = approvedCanary();
  for (let index = 0; index < 11; index += 1) {
    canary = recordCanaryWindow(canary, {
      actorId: "oidc_operations",
      window: healthyWindow(index),
      now: new Date(START.getTime() + (index + 1) * HOUR),
    });
  }
  assert.throws(() => finalizeCanary(canary, {
    verification: {
      id: "verification-early-01",
      verdict: "passed",
      verifiedAt: new Date(START.getTime() + 10 * HOUR).toISOString(),
      evidenceRefs: ["goal-verification:verification-early-01"],
    },
    now: new Date(START.getTime() + 12 * HOUR),
  }), /12/);

  const passed = passedCanary();
  assert.equal(passed.status, "passed");
  assert.equal(passed.report?.schemaVersion, "harness.p12-canary-report.v1");
  assert.equal(passed.report?.observation.windows.length, 12);
});

test("Production release locks ten gates, digest, and one OIDC owner signer", () => {
  const canary = passedCanary();
  let release = createProductionRelease({
    id: ids.releaseId,
    canary,
    actorId: "oidc_operations",
    now: new Date(START.getTime() + 13 * HOUR),
  });
  const gates = [
    "browser-e2e", "identity-security", "autodev-authorization",
    "model-routing-write", "supply-chain", "git-traceability",
    "recovery-stop", "observability-oncall", "canary-goal-verification",
    "defect-budget",
  ];
  const roles = ["owner"];
  gates.forEach((gateId, index) => {
    release = recordProductionGate(release, {
      actorId: `oidc_${roles[index % roles.length]}`,
      gateId,
      ownerRole: roles[index % roles.length],
      evidenceRefs: [`gate-receipt:${gateId}`],
      now: new Date(START.getTime() + 13 * HOUR + index * 1_000),
    });
  });
  release = evaluateProductionRelease(release, {
    actorId: "oidc_owner",
    now: new Date(START.getTime() + 14 * HOUR),
  });
  assert.equal(release.status, "awaiting_signatures");
  assert.match(release.attestationDigest ?? "", /^[0-9a-f]{64}$/);

  roles.forEach((role, index) => {
    release = signProductionRelease(release, {
      actorId: `oidc_${role}`,
      role,
      reason: `Approved ${role} after reviewing the complete Production V1 evidence.`,
      requestId: `release-sign-${role}-01`,
      auditReceiptId: `audit-release-${role}-01`,
      now: new Date(START.getTime() + 14 * HOUR + (index + 1) * 1_000),
    });
  });
  assert.equal(release.status, "approved");
  assert.equal(release.signatures.length, 1);
  assert.equal(release.report?.result, "approved");
});

test("Production evidence locks after evaluation and duplicate owner signatures are rejected", () => {
  let release = createProductionRelease({
    id: ids.releaseId,
    canary: passedCanary(),
    actorId: "oidc_operations",
    now: new Date(START.getTime() + 13 * HOUR),
  });
  const gates = [
    "browser-e2e", "identity-security", "autodev-authorization",
    "model-routing-write", "supply-chain", "git-traceability",
    "recovery-stop", "observability-oncall", "canary-goal-verification",
    "defect-budget",
  ];
  for (const gateId of gates) {
    release = recordProductionGate(release, {
      actorId: "oidc_owner",
      gateId,
      ownerRole: "owner",
      evidenceRefs: [`gate-receipt:${gateId}`],
      now: new Date(START.getTime() + 13 * HOUR),
    });
  }
  release = evaluateProductionRelease(release, {
    actorId: "oidc_owner",
    now: new Date(START.getTime() + 14 * HOUR),
  });
  assert.throws(() => recordProductionGate(release, {
    actorId: "oidc_owner",
    gateId: "browser-e2e",
    ownerRole: "owner",
    evidenceRefs: ["gate-receipt:mutated"],
    now: new Date(START.getTime() + 14 * HOUR),
  }), /locked/);
  release = signProductionRelease(release, {
    actorId: "oidc_same_person",
    role: "owner",
    reason: "Owner evidence and release policy are fully approved.",
    requestId: "release-sign-owner-01",
    auditReceiptId: "audit-release-owner-01",
    now: new Date(START.getTime() + 14 * HOUR),
  });
  assert.throws(() => signProductionRelease(release, {
    actorId: "oidc_same_person",
    role: "owner",
    reason: "Owner evidence and release policy are fully approved again.",
    requestId: "release-sign-owner-02",
    auditReceiptId: "audit-release-owner-02",
    now: new Date(START.getTime() + 14 * HOUR),
  }), /not awaiting signatures/);
});
