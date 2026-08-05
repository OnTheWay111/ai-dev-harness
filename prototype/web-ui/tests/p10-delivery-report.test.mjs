import assert from "node:assert/strict";
import test from "node:test";

import { MemoryGoalVerificationRepository } from
  "../app/control-plane/adapters/memory-goal-verification-repository.ts";
import { DeliveryReportService } from
  "../app/control-plane/application/delivery-report-service.ts";
import { canonicalJson, sha256Hex } from
  "../app/control-plane/domain/spec-artifact.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
};
const criterionRef = "00000000-0000-4000-8000-000000000004";
const plan = {
  schemaVersion: "acceptance-verification-plan.v1",
  id: "00000000-0000-4000-8000-000000000005",
  ...scope,
  goalVersion: 8,
  issuePlanId: "00000000-0000-4000-8000-000000000006",
  issuePlanVersion: 2,
  revision: 1,
  previousPlanId: null,
  entries: [{
    id: "verify-ac-1", criterionRef, environment: "test",
    strategy: { type: "artifact", reference: "artifact:test-output" },
    successCondition: "The immutable test output exists and passed.",
    timeoutMs: 10000, responsibleParty: "quality",
  }],
  compilation: { valid: true, coveredCriterionRefs: [criterionRef] },
  digest: "a".repeat(64), compiledAt: "2026-08-05T08:00:00.000Z", version: 1,
};
const verification = {
  schemaVersion: "goal-verification.v1",
  id: "00000000-0000-4000-8000-000000000007",
  ...scope,
  verificationPlanId: plan.id,
  issuePlanId: plan.issuePlanId,
  revision: 1,
  previousVerificationId: null,
  goalVersion: 8,
  verdict: "passed",
  deterministicResults: [{
    entryId: "verify-ac-1", criterionRef, status: "passed",
    evidenceRefs: ["artifact:test-output"], summary: "passed", durationMs: 10,
  }],
  verifierOutput: {
    schemaVersion: "goal-verifier-output.v1", overallVerdict: "passed",
    criteria: [{ criterionRef, verdict: "passed", evidenceRefs: ["artifact:test-output"], rationale: "Evidence passed." }],
    nonGoals: [{ statement: "No production deployment", verdict: "preserved", rationale: "No deploy occurred." }],
    constraints: [{ statement: "Read-only verifier", verdict: "satisfied", rationale: "Read-only session." }],
    regressionRisks: [{ severity: "low", description: "Monitor the verifier adapter.", evidenceRefs: ["artifact:test-output"] }],
  },
  verifierIdentity: "goal-verifier", verifierVersion: "v1", sessionId: "session-1",
  verifiedAt: "2026-08-05T09:00:00.000Z", version: 1,
};
const source = {
  goal: {
    id: scope.goalId, organizationId: scope.organizationId, projectId: scope.projectId,
    title: "Ship P10", problemStatement: "Goal proof is missing.", desiredOutcome: "Goal proof exists.",
    acceptanceCriteria: [{ id: criterionRef, position: 1, statement: "P10 tests pass.", version: 1 }],
    nonGoals: ["No production deployment"], constraints: ["Read-only verifier"],
    status: "verifying", version: 8,
    createdAt: "2026-08-05T07:00:00.000Z", updatedAt: "2026-08-05T08:00:00.000Z",
  },
  issueRuns: [{
    issueId: "00000000-0000-4000-8000-000000000008", issueKey: "P10-01",
    runId: "00000000-0000-4000-8000-000000000009", status: "completed",
    artifactRefs: ["artifact:test-output"], reviewIds: ["review-1"],
    commitSha: "b".repeat(40), pullRequest: { externalId: "42", url: "https://github.test/acme/repo/pull/42", status: "merged" },
  }],
  exceptions: [],
};

test("P10-04 creates versioned immutable reports, exports them, and completes Goal only after final human acceptance", async () => {
  const repository = new MemoryGoalVerificationRepository({ plans: [plan], verifications: [verification], goals: [source.goal] });
  const service = new DeliveryReportService({
    repository,
    source: { async collect() { return source; } },
    authorizer: { async authorize() {} },
    clock: () => new Date("2026-08-05T10:00:00.000Z"),
  });
  const first = await service.generate({
    ...scope,
    verificationId: verification.id,
    actorId: "operator-1",
    knownRisks: [{ severity: "low", statement: "Monitor verifier upgrades.", disposition: "accepted" }],
  });
  assert.equal(first.status, "awaiting_human_acceptance");
  assert.equal(first.acceptance.length, 1);
  assert.equal(first.issueRuns[0].commitSha, "b".repeat(40));
  assert.equal((await repository.getGoal(scope)).status, "verifying");
  const second = await service.generate({
    ...scope,
    verificationId: verification.id,
    actorId: "operator-1",
    knownRisks: [],
  });
  assert.equal(second.revision, first.revision + 1);
  assert.equal(second.previousReportId, first.id);

  const completed = await service.accept({
    ...scope,
    reportId: second.id,
    actorId: "approver-1",
    expectedGoalVersion: 8,
    reason: "All evidence and disclosed risks are accepted for delivery.",
    requestId: "accept-report-1",
    idempotencyKey: "accept-delivery-report-1",
  });
  assert.equal(completed.report.status, "accepted");
  assert.equal(completed.report.humanAcceptance.actorId, "approver-1");
  assert.equal(completed.goal.status, "completed");
  const { digest, ...acceptedPayload } = completed.report;
  assert.equal(digest, await sha256Hex(canonicalJson(acceptedPayload)));
  const replay = await service.accept({
    ...scope,
    reportId: second.id,
    actorId: "approver-1",
    expectedGoalVersion: 8,
    reason: "All evidence and disclosed risks are accepted for delivery.",
    requestId: "accept-report-1",
    idempotencyKey: "accept-delivery-report-1",
  });
  assert.deepEqual(replay, completed);
  const exported = await service.export({ ...scope, reportId: completed.report.id, actorId: "viewer-1" });
  assert.match(exported.fileName, /delivery-report.*\.json$/);
  assert.equal(JSON.parse(exported.body).digest, completed.report.digest);
});

test("P10-04 refuses reports or Goal completion when evidence, criterion verdicts, or gates are missing", async () => {
  for (const scenario of ["missing-evidence", "failed-verdict", "wrong-role"]) {
    const changedVerification = structuredClone(verification);
    const changedSource = structuredClone(source);
    if (scenario === "missing-evidence") changedSource.issueRuns[0].artifactRefs = [];
    if (scenario === "failed-verdict") changedVerification.verdict = "failed";
    const repository = new MemoryGoalVerificationRepository({ plans: [plan], verifications: [changedVerification], goals: [source.goal] });
    const service = new DeliveryReportService({
      repository,
      source: { async collect() { return changedSource; } },
      authorizer: {
        async authorize(input) {
          if (scenario === "wrong-role" && input.permission === "goal.accept") throw new Error("forbidden");
        },
      },
    });
    if (scenario !== "wrong-role") {
      await assert.rejects(
        () => service.generate({ ...scope, verificationId: changedVerification.id, actorId: "operator", knownRisks: [] }),
        /evidence|verification/i,
      );
      continue;
    }
    const report = await service.generate({ ...scope, verificationId: changedVerification.id, actorId: "operator", knownRisks: [] });
    await assert.rejects(() => service.accept({
      ...scope, reportId: report.id, actorId: "viewer", expectedGoalVersion: 8,
      reason: "Unauthorized acceptance", requestId: "request-2", idempotencyKey: "delivery-accept-2",
    }), /forbidden/);
    assert.equal((await repository.getGoal(scope)).status, "verifying");
  }
});
