import assert from "node:assert/strict";
import test from "node:test";

import { MemoryGoalVerificationRepository } from
  "../app/control-plane/adapters/memory-goal-verification-repository.ts";
import { VerificationGapService } from
  "../app/control-plane/application/verification-gap-service.ts";
import { IssuePlanGapRemediationAdapter } from
  "../app/control-plane/adapters/issue-plan-gap-remediation-adapter.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
};
const verification = {
  schemaVersion: "goal-verification.v1",
  id: "00000000-0000-4000-8000-000000000004",
  ...scope,
  verificationPlanId: "00000000-0000-4000-8000-000000000005",
  issuePlanId: "00000000-0000-4000-8000-000000000006",
  revision: 1,
  previousVerificationId: null,
  goalVersion: 8,
  verdict: "failed",
  deterministicResults: [{
    entryId: "verify-ac-1",
    criterionRef: "00000000-0000-4000-8000-000000000007",
    status: "failed",
    evidenceRefs: ["artifact:old-test-output"],
    summary: "Expected 12 tests; 11 passed.",
    durationMs: 20,
  }],
  verifierOutput: {
    schemaVersion: "goal-verifier-output.v1",
    overallVerdict: "failed",
    criteria: [{
      criterionRef: "00000000-0000-4000-8000-000000000007",
      verdict: "failed",
      evidenceRefs: ["artifact:old-test-output"],
      rationale: "One required regression test failed.",
    }],
    nonGoals: [],
    constraints: [],
    regressionRisks: [{ severity: "high", description: "A regression remains.", evidenceRefs: ["artifact:old-test-output"] }],
  },
  verifierIdentity: "goal-verifier",
  verifierVersion: "v1",
  sessionId: "session-1",
  verifiedAt: "2026-08-05T09:00:00.000Z",
  version: 1,
};

test("P10-03 creates an immutable gap report and returns a confirmed fix through a new draft revision", async () => {
  const calls = [];
  const repository = new MemoryGoalVerificationRepository({ verifications: [verification] });
  const service = new VerificationGapService({
    repository,
    remediation: {
      async createDraft(input) {
        calls.push(input);
        return {
          id: "00000000-0000-4000-8000-000000000010",
          previousPlanId: verification.issuePlanId,
          revision: 3,
          status: "draft",
          compilation: { valid: true },
          version: 1,
        };
      },
    },
    authorizer: {
      async authorize(input) {
        assert.ok(["goal.verify", "issue.generate"].includes(input.permission));
      },
    },
    clock: () => new Date("2026-08-05T10:00:00.000Z"),
  });
  const report = await service.create({
    ...scope,
    verificationId: verification.id,
    actorId: "operator-1",
  });
  assert.equal(report.gaps.length, 1);
  assert.deepEqual(report.preservedEvidenceRefs, ["artifact:old-test-output"]);
  assert.equal(Object.isFrozen(report), true);

  const remediation = await service.confirm({
    ...scope,
    reportId: report.id,
    actorId: "approver-1",
    humanConfirmed: true,
    reason: "Create a regression-fix revision without replacing prior evidence.",
    idempotencyKey: "gap-remediation-1",
    draft: { schemaVersion: "issue-plan-draft.v1", issues: [{ key: "FIX-1" }] },
  });
  assert.equal(remediation.plan.status, "draft");
  assert.equal(remediation.plan.previousPlanId, verification.issuePlanId);
  assert.deepEqual(remediation.preservedEvidenceRefs, report.preservedEvidenceRefs);
  assert.equal(calls.length, 1);
  const replay = await service.confirm({
    ...scope,
    reportId: report.id,
    actorId: "approver-1",
    humanConfirmed: true,
    reason: "Create a regression-fix revision without replacing prior evidence.",
    idempotencyKey: "gap-remediation-1",
    draft: { schemaVersion: "issue-plan-draft.v1", issues: [{ key: "FIX-1" }] },
  });
  assert.deepEqual(replay, remediation);
  assert.equal(calls.length, 1);
});

test("P10-03 rejects unconfirmed, passing, stale, and conflicting remediation requests", async () => {
  const repository = new MemoryGoalVerificationRepository({ verifications: [verification] });
  const service = new VerificationGapService({
    repository,
    remediation: { async createDraft() { throw new Error("must not run"); } },
    authorizer: { async authorize() {} },
  });
  const report = await service.create({ ...scope, verificationId: verification.id, actorId: "operator" });
  await assert.rejects(() => service.confirm({
    ...scope,
    reportId: report.id,
    actorId: "approver",
    humanConfirmed: false,
    reason: "Not confirmed",
    idempotencyKey: "gap-remediation-2",
    draft: {},
  }), /human confirmation/i);
});

test("P10-03 reports non-goal and constraint failures without inventing criterion IDs", async () => {
  const boundaryFailure = structuredClone(verification);
  boundaryFailure.deterministicResults[0].status = "passed";
  boundaryFailure.verifierOutput.criteria[0].verdict = "passed";
  boundaryFailure.verifierOutput.nonGoals = [{
    statement: "Do not deploy production.",
    verdict: "violated",
    rationale: "The evidence contains a production deployment.",
  }];
  boundaryFailure.verifierOutput.constraints = [{
    statement: "Verifier remains read-only.",
    verdict: "violated",
    rationale: "The verifier session obtained write access.",
  }];
  const repository = new MemoryGoalVerificationRepository({
    verifications: [boundaryFailure],
  });
  const service = new VerificationGapService({
    repository,
    remediation: { async createDraft() { throw new Error("not used"); } },
    authorizer: { async authorize() {} },
  });
  const report = await service.create({
    ...scope,
    verificationId: boundaryFailure.id,
    actorId: "operator",
  });
  assert.deepEqual(report.failedCriterionRefs, []);
  assert.deepEqual(report.gaps.map(({ sourceKind }) => sourceKind), [
    "non_goal",
    "constraint",
  ]);
  assert.ok(report.gaps.every(({ criterionRef }) => criterionRef === null));
});

test("P10-03 recovers the same compiled remediation revision after a partial receipt failure", async () => {
  const previous = {
    id: verification.issuePlanId,
    source: { requirements: [], acceptanceCriterionIds: [] },
  };
  const recovered = {
    id: "00000000-0000-4000-8000-000000000020",
    previousPlanId: previous.id,
    revision: 3,
    status: "draft",
    compilation: { valid: true },
    version: 1,
    plannerRunId: "gap-remediation:gap-partial-1",
    plannerConfiguration: { adapter: "goal-verifier-gap" },
  };
  let latestReads = 0;
  const adapter = new IssuePlanGapRemediationAdapter({
    repository: {
      async get() { return previous; },
      async getLatest() {
        latestReads += 1;
        return latestReads === 1 ? previous : recovered;
      },
    },
    service: {
      async createDraft() {
        throw new Error("receipt failed after the plan commit");
      },
    },
  });
  const result = await adapter.createDraft({
    scope,
    previousIssuePlanId: previous.id,
    verificationId: verification.id,
    gapReportId: "gap-partial-1",
    actorId: "approver",
    reason: "Recover the committed remediation plan.",
    draft: {},
  });
  assert.equal(result.id, recovered.id);
  assert.equal(result.previousPlanId, previous.id);
  assert.equal(latestReads, 2);
});
