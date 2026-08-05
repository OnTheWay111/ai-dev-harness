import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateSupplyChainFindings,
  validateSupplyChainExceptions,
  validateSupplyChainPolicy,
} from "../app/security/supply-chain-policy.ts";

const policyUrl = new URL(
  "../../../ops/production/supply-chain-policy.json",
  import.meta.url,
);
const exceptionsUrl = new URL(
  "../../../ops/production/supply-chain-exceptions.json",
  import.meta.url,
);
const baselineUrl = new URL(
  "../../../docs/evidence/p11-supply-chain-baseline-2026-08-05.json",
  import.meta.url,
);

test("P11 supply-chain policy covers secrets, SCA, licenses, SBOM, build, image and provenance", async () => {
  const policy = JSON.parse(await readFile(policyUrl, "utf8"));
  validateSupplyChainPolicy(policy);
  assert.deepEqual(policy.blockSeverities, ["critical", "high"]);
  assert.deepEqual(policy.requiredSurfaces.sort(), [
    "build-artifact", "container-image", "license", "provenance",
    "python-sca", "repository-secret", "sbom", "web-sca",
  ]);
  assert.equal(policy.containerImage.currentStatus, "not-applicable");
  assert.equal(policy.containerImage.failIfBuildDefinitionAppears, true);
  assert.equal(policy.exceptions.maximumDays, 90);
});

test("P11 blocks Critical/High findings and permits only exact valid exceptions", async () => {
  const exceptions = JSON.parse(await readFile(exceptionsUrl, "utf8"));
  validateSupplyChainExceptions(exceptions,
    new Date("2026-08-05T00:00:00.000Z"));
  const findings = [
    { id: "CVE-critical", component: "web", kind: "vulnerability", severity: "critical" },
    { id: "license:autodev-harness:LicenseRef-Proprietary", component: "autodev-harness", kind: "license", severity: "high" },
    { id: "CVE-medium", component: "drizzle-kit", kind: "vulnerability", severity: "moderate" },
  ];
  const result = evaluateSupplyChainFindings({
    findings,
    exceptions: exceptions.exceptions,
    now: "2026-08-05T00:00:00.000Z",
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockers.map((item) => item.id), ["CVE-critical"]);
  assert.deepEqual(result.waived.map((item) => item.id),
    ["license:autodev-harness:LicenseRef-Proprietary"]);
  assert.deepEqual(result.nonBlocking.map((item) => item.id), ["CVE-medium"]);
});

test("P11 secrets cannot be waived and expired/ownerless exceptions fail closed", () => {
  const exception = {
    id: "secret:synthetic",
    component: "repository",
    kind: "secret",
    owner: "platform-security",
    approvedBy: "repository-maintainer",
    reason: "Synthetic exception must never be honored for a repository Secret.",
    scope: "internal-production-only",
    expiresAt: "2026-08-06T00:00:00.000Z",
    constraints: ["no-redistribution"],
  };
  const result = evaluateSupplyChainFindings({
    findings: [{ id: "secret:synthetic", component: "repository", kind: "secret", severity: "critical" }],
    exceptions: [exception],
    now: "2026-08-05T00:00:00.000Z",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.blockers.length, 1);
  assert.throws(() => validateSupplyChainExceptions({
    schemaVersion: "harness.supply-chain-exceptions.v1",
    exceptions: [{ ...exception, owner: "", kind: "license" }],
  }, new Date("2026-08-05T00:00:00.000Z")), /owner/i);
  assert.throws(() => validateSupplyChainExceptions({
    schemaVersion: "harness.supply-chain-exceptions.v1",
    exceptions: [{ ...exception, kind: "license", expiresAt: "2026-08-04T00:00:00.000Z" }],
  }, new Date("2026-08-05T00:00:00.000Z")), /expired/i);
});

test("P11 CI failure path reports a synthetic High finding as a blocker", () => {
  const result = evaluateSupplyChainFindings({
    findings: [{
      id: "CVE-synthetic-high",
      component: "fixture-only",
      kind: "vulnerability",
      severity: "high",
    }],
    exceptions: [],
    now: "2026-08-05T00:00:00.000Z",
  });
  assert.deepEqual(result, {
    allowed: false,
    blockers: [{
      id: "CVE-synthetic-high",
      component: "fixture-only",
      kind: "vulnerability",
      severity: "high",
    }],
    waived: [],
    nonBlocking: [],
  });
});

test("P11 CI pins actions and enforces every supply-chain gate", async () => {
  const workflow = await readFile(new URL(
    "../../../.github/workflows/p1-postgres.yml",
    import.meta.url,
  ), "utf8");
  const uses = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)]
    .map((match) => match[1]);
  assert.ok(uses.length >= 8);
  assert.ok(uses.every((value) => /@[0-9a-f]{40}$/.test(value)), uses.join("\n"));
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.match(workflow, /pip-audit --requirement autodev\/requirements-dev\.lock --strict/);
  assert.match(workflow, /scanners: vuln,secret,misconfig,license/);
  assert.match(workflow, /version: v0\.73\.0/);
  assert.match(workflow, /skip-setup-trivy: true/);
  assert.match(workflow, /scan-ref: prototype\/web-ui\/dist/);
  assert.match(workflow, /security:artifacts:p11/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  assert.doesNotMatch(workflow, /audit fix|--force/);
  assert.match(workflow, /postgres:16@sha256:[0-9a-f]{64}/);
});

test("P11 baseline closes blockers and binds raw scans, SBOMs, and build evidence", async () => {
  const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
  assert.equal(baseline.result, "passed");
  assert.equal(baseline.blockingFindingCount, 0);
  assert.deepEqual(baseline.policy.blockSeverities, ["critical", "high"]);
  assert.equal(baseline.scans.webDependencies.production.total, 0);
  assert.equal(baseline.scans.webDependencies.all.critical, 0);
  assert.equal(baseline.scans.webDependencies.all.high, 0);
  assert.equal(baseline.scans.pythonDependencies.vulnerabilityCount, 0);
  assert.equal(baseline.scans.repository.critical, 0);
  assert.equal(baseline.scans.repository.high, 0);
  assert.equal(baseline.scans.webBuildArtifact.critical, 0);
  assert.equal(baseline.scans.webBuildArtifact.high, 0);
  assert.equal(baseline.ci.syntheticHighFailurePathPassed, true);
  assert.ok(baseline.exceptionIds.includes(
    "license:autodev-harness:LicenseRef-Proprietary"));

  for (const item of [
    baseline.scans.repository,
    baseline.scans.webBuildArtifact,
    ...baseline.artifacts,
  ]) {
    const bytes = await readFile(new URL(`../../../docs/evidence/${item.report ?? item.path}`,
      import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"),
      item.reportSha256 ?? item.sha256);
  }
});
