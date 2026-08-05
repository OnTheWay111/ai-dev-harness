import assert from "node:assert/strict";
import test from "node:test";

import { validateP12CanaryReport } from "../app/reliability/p12-canary-gate.ts";

const HOUR = 60 * 60 * 1000;
const START = Date.parse("2026-08-05T00:00:00.000Z");
const AFTER_CANARY = new Date(START + 49 * HOUR);

function validate(value) {
  return validateP12CanaryReport(value, { now: AFTER_CANARY });
}

function windows(count = 48) {
  return Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    startedAt: new Date(START + index * HOUR).toISOString(),
    endedAt: new Date(START + (index + 1) * HOUR).toISOString(),
    status: "healthy",
    p0Count: 0,
    p1Count: 0,
    evidenceRefs: [`metric-window:${String(index + 1).padStart(2, "0")}`],
  }));
}

function report(overrides = {}) {
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
      allowedAreas: ["documentation", "non-production-tooling"],
      excludedAreas: ["production-data", "credentials", "billing"],
    },
    conditions: {
      success: ["Goal Verification passed", "No P0/P1 for 48 continuous hours"],
      stop: ["Any P0/P1", "data integrity alert", "owner requests Stop"],
      rollbackRunbook: "docs/runbooks/deployment-rollback-upgrade.md",
      stopRunbook: "docs/runbooks/execution-stop-worker-loss.md",
    },
    observation: {
      requiredDurationHours: 48,
      startedAt: new Date(START).toISOString(),
      endedAt: new Date(START + 48 * HOUR).toISOString(),
      windows: windows(),
    },
    defects: [
      {
        id: "P2-001",
        severity: "P2",
        ownerId: "p2-owner-01",
        workaround: "Use the bounded manual retry Runbook.",
        status: "mitigated",
      },
    ],
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
    ...overrides,
  };
}

test("accepts 48 contiguous healthy hours with Goal Verification and owned P2", () => {
  const result = validate(report());
  assert.equal(result.durationHours, 48);
  assert.equal(result.windowCount, 48);
  assert.equal(result.p2Count, 1);
});

test("rejects a shortened or future observation", () => {
  const shortened = report();
  shortened.observation.endedAt = new Date(START + 47 * HOUR).toISOString();
  shortened.observation.windows = windows(47);
  assert.throws(() => validate(shortened), /48/);
  assert.throws(
    () => validateP12CanaryReport(report(), { now: new Date(START + 47 * HOUR) }),
    /future/,
  );
});

test("rejects missing observation time and P0/P1 defects", () => {
  const gap = report();
  gap.observation.windows[20].startedAt = new Date(START + 21.5 * HOUR).toISOString();
  assert.throws(() => validate(gap), /contiguous/);

  const incident = report({
    defects: [{ id: "P1-001", severity: "P1", ownerId: "owner", workaround: "Stop", status: "open" }],
  });
  assert.throws(() => validate(incident), /P0\/P1/);
});

test("rejects ownerless P2, failed Goal Verification, and unresolved gaps", () => {
  const ownerless = report();
  ownerless.defects[0].ownerId = "";
  assert.throws(() => validate(ownerless), /ownerId/);
  assert.throws(
    () => validate(report({ goalVerification: { ...report().goalVerification, status: "failed" } })),
    /Goal Verification/,
  );
  assert.throws(() => validate(report({ gaps: ["missing alert receipt"] })), /gaps/);
  const placeholderOwner = report();
  placeholderOwner.project.ownerId = "test-user";
  assert.throws(() => validate(placeholderOwner), /placeholder/);
});
