const SCHEMA_VERSION = "harness.p12-real-autodev-drill.v1";
const MODE = "isolated-real-autodev-codex";
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const LOCAL_PATH = /\/(?:Users|home|private|tmp)\//;
const SECRET_LITERAL = /(?:Bearer\s+[A-Za-z0-9._~-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@)/i;

export interface P12RealAutoDevDrillReport {
  schemaVersion: string;
  drillId: string;
  mode: string;
  startedAt: string;
  completedAt: string;
  versions: { autoDev: string; codex: string };
  isolation: {
    repository: string;
    remote: string;
    productionCredentials: boolean;
    notifications: string;
  };
  delivery: {
    issueIds: string[];
    successfulRunIds: string[];
    builder: { identity: string; model: string };
    reviewer: { identity: string; model: string; readOnly: boolean };
    verifyCommands: string[];
    commits: string[];
    remoteRef: string;
    pullRequest: { kind: string; headCommit: string };
  };
  recovery: {
    lostRunId: string;
    workerExitCode: number;
    stopProofRunId: string;
    claimsWhileStopped: number;
    liveLeasesBeforeLoss: number;
    liveLeasesAfterReconciliation: number;
    recoveryRunId: string;
    maxConcurrentActiveRunsForTask: number;
    effectiveBuilderStartsForRecoveredTask: number;
  };
  assertions: Record<string, boolean>;
  privacy: { secretLiteralCount: number; redacted: string[] };
  gaps: string[];
  result: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be a string array`);
  }
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

function assertDelivery(raw: Record<string, unknown>): number {
  const issueIds = strings(raw.issueIds, "delivery.issueIds");
  const runIds = strings(raw.successfulRunIds, "delivery.successfulRunIds");
  if (issueIds.length < 2 || runIds.length < 2) {
    throw new Error("delivery must include the main path and recovered task");
  }
  const builder = object(raw.builder, "delivery.builder");
  const reviewer = object(raw.reviewer, "delivery.reviewer");
  const builderIdentity = string(builder.identity, "delivery.builder.identity");
  const reviewerIdentity = string(reviewer.identity, "delivery.reviewer.identity");
  string(builder.model, "delivery.builder.model");
  string(reviewer.model, "delivery.reviewer.model");
  if (builderIdentity === reviewerIdentity || reviewer.readOnly !== true) {
    throw new Error("delivery reviewer must be independent and read-only");
  }
  const verify = strings(raw.verifyCommands, "delivery.verifyCommands");
  if (!verify.includes("git diff --check") || !verify.some((item) => item.includes("unittest"))) {
    throw new Error("delivery verification evidence is incomplete");
  }
  const commits = strings(raw.commits, "delivery.commits");
  if (commits.length < 2 || commits.some((commit) => !COMMIT_SHA.test(commit))) {
    throw new Error("delivery commits must contain two full Git SHAs");
  }
  const remoteRef = string(raw.remoteRef, "delivery.remoteRef");
  if (!remoteRef.startsWith("refs/heads/autodev/")) {
    throw new Error("delivery remote ref must be an isolated AutoDev branch");
  }
  const pullRequest = object(raw.pullRequest, "delivery.pullRequest");
  if (pullRequest.kind !== "git-request-pull" ||
      !commits.includes(string(pullRequest.headCommit, "delivery.pullRequest.headCommit"))) {
    throw new Error("delivery pull request evidence is invalid");
  }
  return issueIds.length;
}

function assertRecovery(raw: Record<string, unknown>): void {
  for (const key of ["lostRunId", "stopProofRunId", "recoveryRunId"]) {
    if (!SAFE_ID.test(string(raw[key], `recovery.${key}`))) {
      throw new Error(`recovery.${key} is invalid`);
    }
  }
  const valid = integer(raw.workerExitCode, "recovery.workerExitCode") < 0 &&
    integer(raw.claimsWhileStopped, "recovery.claimsWhileStopped") === 0 &&
    integer(raw.liveLeasesBeforeLoss, "recovery.liveLeasesBeforeLoss") === 1 &&
    integer(raw.liveLeasesAfterReconciliation,
      "recovery.liveLeasesAfterReconciliation") === 0 &&
    integer(raw.maxConcurrentActiveRunsForTask,
      "recovery.maxConcurrentActiveRunsForTask") === 1 &&
    integer(raw.effectiveBuilderStartsForRecoveredTask,
      "recovery.effectiveBuilderStartsForRecoveredTask") === 1;
  if (!valid) throw new Error("recovery lease, Stop, or duplicate-run proof is invalid");
}

export function validateP12RealAutoDevDrillReport(value: unknown): {
  assertionCount: number;
  issueCount: number;
} {
  const report = object(value, "report");
  if (report.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported schemaVersion");
  if (report.mode !== MODE) throw new Error("mode must record real AutoDev/Codex execution");
  if (!SAFE_ID.test(string(report.drillId, "drillId"))) throw new Error("drillId is invalid");
  const startedAt = timestamp(report.startedAt, "startedAt");
  const completedAt = timestamp(report.completedAt, "completedAt");
  if (completedAt < startedAt) throw new Error("completedAt precedes startedAt");

  const versions = object(report.versions, "versions");
  if (versions.autoDev !== "0.4.16" || !/^\d+\.\d+\.\d+$/.test(string(versions.codex,
    "versions.codex"))) {
    throw new Error("versions do not match the approved real toolchain");
  }
  const isolation = object(report.isolation, "isolation");
  if (isolation.repository !== "disposable-outside-product-repository" ||
      isolation.remote !== "local-bare-git" ||
      isolation.productionCredentials !== false ||
      isolation.notifications !== "dry_run") {
    throw new Error("isolation must exclude production credentials and external writes");
  }

  const issueCount = assertDelivery(object(report.delivery, "delivery"));
  assertRecovery(object(report.recovery, "recovery"));

  const assertions = object(report.assertions, "assertions");
  const requiredAssertions = [
    "realAutoDev", "realCodexBuilder", "worktreeIsolated", "testsPassed",
    "independentReviewGreen", "commitPushed", "pullRequestGenerated",
    "workerLossObserved", "globalStopPreventedClaim", "staleLeaseReconciled",
    "noDuplicateActiveRun", "evidenceComplete",
  ];
  if (Object.keys(assertions).length !== requiredAssertions.length ||
      requiredAssertions.some((key) => assertions[key] !== true)) {
    throw new Error("all required drill assertions must be true");
  }
  const privacy = object(report.privacy, "privacy");
  if (privacy.secretLiteralCount !== 0) throw new Error("report contains secret literals");
  const redacted = new Set(strings(privacy.redacted, "privacy.redacted"));
  for (const item of ["absolute-paths", "lease-token", "session-id", "prompts", "raw-logs"]) {
    if (!redacted.has(item)) throw new Error(`privacy redaction is missing ${item}`);
  }
  if (strings(report.gaps, "gaps").length !== 0 || report.result !== "passed") {
    throw new Error("drill has unresolved gaps or did not pass");
  }

  const serialized = JSON.stringify(report);
  if (LOCAL_PATH.test(serialized) || SECRET_LITERAL.test(serialized)) {
    throw new Error("report contains a local path or secret literal");
  }
  return { assertionCount: requiredAssertions.length, issueCount };
}
