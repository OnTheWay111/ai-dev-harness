import assert from "node:assert/strict";
import test from "node:test";

import {
  validateP12RealAutoDevDrillReport,
} from "../app/reliability/p12-real-autodev-drill.ts";

function report(overrides = {}) {
  return {
    schemaVersion: "harness.p12-real-autodev-drill.v1",
    drillId: "p12-real-autodev-20260805-01",
    mode: "isolated-real-autodev-codex",
    startedAt: "2026-08-05T04:38:42.000Z",
    completedAt: "2026-08-05T04:53:15.000Z",
    versions: { autoDev: "0.4.16", codex: "0.144.6" },
    isolation: {
      repository: "disposable-outside-product-repository",
      remote: "local-bare-git",
      productionCredentials: false,
      notifications: "dry_run",
    },
    delivery: {
      issueIds: ["H-001", "H-002"],
      successfulRunIds: [
        "p12-real-autodev-codex-green",
        "p12-worker-recovery-loop-task-01",
      ],
      builder: { identity: "codex", model: "gpt-5.6-terra" },
      reviewer: { identity: "codex_check", model: "gpt-5.6-sol", readOnly: true },
      verifyCommands: ["python -m unittest discover -s tests -v", "git diff --check"],
      commits: [
        "34f1cca5848c0660ac292a30fb357e1d27d6c088",
        "2523ee9c4bd0d638b37a0474aaf09bf543e9e5d8",
      ],
      remoteRef: "refs/heads/autodev/p12-real-drill/20260805",
      pullRequest: { kind: "git-request-pull", headCommit: "2523ee9c4bd0d638b37a0474aaf09bf543e9e5d8" },
    },
    recovery: {
      lostRunId: "p12-worker-loss-loop-2-task-01",
      workerExitCode: -9,
      stopProofRunId: "p12-global-stop-proof",
      claimsWhileStopped: 0,
      liveLeasesBeforeLoss: 1,
      liveLeasesAfterReconciliation: 0,
      recoveryRunId: "p12-worker-recovery-loop-task-01",
      maxConcurrentActiveRunsForTask: 1,
      effectiveBuilderStartsForRecoveredTask: 1,
    },
    assertions: {
      realAutoDev: true,
      realCodexBuilder: true,
      worktreeIsolated: true,
      testsPassed: true,
      independentReviewGreen: true,
      commitPushed: true,
      pullRequestGenerated: true,
      workerLossObserved: true,
      globalStopPreventedClaim: true,
      staleLeaseReconciled: true,
      noDuplicateActiveRun: true,
      evidenceComplete: true,
    },
    privacy: {
      secretLiteralCount: 0,
      redacted: ["absolute-paths", "lease-token", "session-id", "prompts", "raw-logs"],
    },
    gaps: [],
    result: "passed",
    ...overrides,
  };
}

test("accepts a complete real AutoDev/Codex Stop and recovery report", () => {
  const result = validateP12RealAutoDevDrillReport(report());
  assert.equal(result.assertionCount, 12);
  assert.equal(result.issueCount, 2);
});

test("rejects fake execution modes and production credentials", () => {
  assert.throws(
    () => validateP12RealAutoDevDrillReport(report({ mode: "fixture" })),
    /mode/,
  );
  assert.throws(
    () => validateP12RealAutoDevDrillReport(report({
      isolation: { ...report().isolation, productionCredentials: true },
    })),
    /production credentials/,
  );
});

test("rejects missing Stop, reconciliation, or duplicate-run proof", () => {
  const invalid = report();
  invalid.recovery.claimsWhileStopped = 1;
  invalid.recovery.liveLeasesAfterReconciliation = 1;
  invalid.recovery.maxConcurrentActiveRunsForTask = 2;
  assert.throws(() => validateP12RealAutoDevDrillReport(invalid), /recovery/);
});

test("rejects reports with false assertions, gaps, secrets, or local paths", () => {
  for (const invalid of [
    report({ assertions: { ...report().assertions, testsPassed: false } }),
    report({ gaps: ["review not executed"] }),
    report({ privacy: { ...report().privacy, secretLiteralCount: 1 } }),
    report({ drillId: "/private/tmp/p12-secret" }),
  ]) {
    assert.throws(() => validateP12RealAutoDevDrillReport(invalid));
  }
});
