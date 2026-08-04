import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MemoryIssuePlanRepository } from
  "../app/control-plane/adapters/memory-issue-plan-repository.ts";
import {
  IssuePlanService,
  IssuePlanApprovalError,
} from "../app/control-plane/application/issue-plan-service.ts";
import { VersionConflictError } from
  "../app/control-plane/domain/errors.ts";
import { validateIssuePlanDraft } from
  "../app/control-plane/domain/issue-plan.ts";

const draft = validateIssuePlanDraft(JSON.parse(readFileSync(new URL(
  "fixtures/issue-plan/v1-golden.json",
  import.meta.url,
), "utf8")));
const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
};
const source = {
  specRevisionId: "00000000-0000-4000-8000-000000000004",
  specRevisionVersion: 2,
  specArtifactDigest: "a".repeat(64),
  requirements: [
    { id: "REQ-01", acceptanceCriterionRefs: ["AC-01"] },
    { id: "REQ-02", acceptanceCriterionRefs: ["AC-02"] },
  ],
  acceptanceCriterionIds: ["AC-01", "AC-02"],
};

function command(overrides = {}) {
  return {
    scope,
    target: { type: "issue_plan", id: "00000000-0000-4000-8000-000000000010" },
    expectedVersion: 1,
    actorId: "approver-1",
    reason: "Approve the compiled plan",
    requestId: "request-1",
    idempotencyKey: "idem-1",
    policyRevision: "issue-plan-approval.v1",
    decision: "approve",
    affectedItemIds: ["DEV-01", "DEV-02"],
    payload: {},
    ...overrides,
  };
}

async function setup() {
  const repository = new MemoryIssuePlanRepository();
  let id = 10;
  const service = new IssuePlanService({
    repository,
    authorizer: { async authorize() {} },
    idGenerator: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
    clock: () => new Date("2026-08-04T06:00:00.000Z"),
  });
  const generated = await service.createDraft({
    scope,
    source,
    draft,
    plannerRunId: "planner-run-1",
    plannerConfiguration: {
      adapter: "fake",
      modelProfile: "configured-planner",
      schemaVersion: "issue-plan-draft.v1",
    },
    actorId: "planner-operator",
  });
  return { repository, service, generated };
}

test("P6-05 creates a compiled plan with waves and model recommendations", async () => {
  const { generated } = await setup();
  assert.equal(generated.plan.status, "draft");
  assert.equal(generated.plan.compilation.valid, true);
  assert.deepEqual(generated.plan.waves.map(({ issueKeys }) => issueKeys), [
    ["DEV-01"], ["DEV-02"],
  ]);
  assert.equal(generated.plan.modelRecommendations.length, 2);
  assert.equal(generated.plan.source.specRevisionId, source.specRevisionId);
  assert.match(generated.plan.digest, /^[0-9a-f]{64}$/);
});

test("P6-05 controlled edits always create a new revision and recompile", async () => {
  const { service, generated } = await setup();
  const issues = structuredClone(generated.plan.issues);
  issues[1].dependencyCandidates = ["MISSING"];
  const revised = await service.revise({
    scope,
    planId: generated.plan.id,
    expectedVersion: 1,
    actorId: "approver-1",
    reason: "Test an alternative dependency",
    requestId: "request-revise",
    issues,
    modelOverrides: [],
  });
  assert.equal(revised.plan.revision, 2);
  assert.equal(revised.plan.previousPlanId, generated.plan.id);
  assert.equal(revised.plan.compilation.valid, false);
  await assert.rejects(
    () => service.approve(command({
      target: { type: "issue_plan", id: revised.plan.id },
      affectedItemIds: revised.plan.issues.map(({ key }) => key),
    })),
    IssuePlanApprovalError,
  );
});

test("P6-04 controlled edits preserve existing route overrides and reject unknown routes", async () => {
  const { service, generated } = await setup();
  const overridden = await service.revise({
    scope,
    planId: generated.plan.id,
    expectedVersion: 1,
    actorId: "approver-1",
    reason: "Use a stronger route for the persistence change",
    requestId: "request-route-1",
    issues: generated.plan.issues,
    modelOverrides: [{
      issueKey: "DEV-01",
      capabilityTier: "frontier",
      reasoningEffort: "highest",
      actorId: "approver-1",
      reason: "The persistence boundary merits the strongest review",
      overriddenAt: "2026-08-04T06:00:00.000Z",
    }],
  });
  const editedIssues = structuredClone(overridden.plan.issues);
  editedIssues[1].title = "Expose exact Issue plan approval";
  const edited = await service.revise({
    scope,
    planId: overridden.plan.id,
    expectedVersion: 1,
    actorId: "approver-1",
    reason: "Clarify the approval title",
    requestId: "request-route-2",
    issues: editedIssues,
    modelOverrides: [],
  });
  const preserved = edited.plan.modelRecommendations
    .find(({ issueKey }) => issueKey === "DEV-01");
  assert.equal(preserved.capabilityTier, "frontier");
  assert.equal(
    preserved.override.reason,
    "The persistence boundary merits the strongest review",
  );
  await assert.rejects(() => service.revise({
    scope,
    planId: edited.plan.id,
    expectedVersion: 1,
    actorId: "approver-1",
    reason: "Attempt an unknown route",
    requestId: "request-route-3",
    issues: edited.plan.issues,
    modelOverrides: [{
      issueKey: "DEV-404",
      capabilityTier: "frontier",
      reasoningEffort: "highest",
      actorId: "approver-1",
      reason: "This route does not identify an Issue",
      overriddenAt: "2026-08-04T06:00:00.000Z",
    }],
  }), IssuePlanApprovalError);
});

test("P6-05 approval binds the exact full revision and stale writes return conflicts", async () => {
  const { repository, service, generated } = await setup();
  const receipt = await service.approve(command({
    target: { type: "issue_plan", id: generated.plan.id },
  }));
  assert.equal(receipt.result.plan.status, "approved");
  assert.equal(receipt.previousVersion, 1);
  assert.equal(receipt.currentVersion, 2);
  assert.equal(receipt.result.planDigest, generated.plan.digest);
  assert.equal(repository.auditEvents.length, 1);
  assert.equal(repository.outboxEvents.length, 1);
  await assert.rejects(
    () => service.approve(command({
      idempotencyKey: "idem-stale",
      requestId: "request-stale",
    })),
    VersionConflictError,
  );
});

test("P6-05 request changes keeps the plan editable at the decision version", async () => {
  const { service, generated } = await setup();
  const receipt = await service.approve(command({
    target: { type: "issue_plan", id: generated.plan.id },
    decision: "request_changes",
    reason: "Clarify the approval Issue title",
  }));
  assert.equal(receipt.result.plan.status, "draft");
  assert.equal(receipt.result.plan.version, 2);
  const issues = structuredClone(receipt.result.plan.issues);
  issues[1].title = "Expose exact Issue plan approval";
  const revised = await service.revise({
    scope,
    planId: receipt.result.plan.id,
    expectedVersion: 2,
    actorId: "approver-1",
    reason: "Apply the requested clarification",
    requestId: "request-after-changes",
    issues,
    modelOverrides: [],
  });
  assert.equal(revised.plan.revision, 2);
});

test("P6-05 authorizes before reads and rejects weak approval metadata", async () => {
  let reads = 0;
  const repository = new MemoryIssuePlanRepository();
  const original = repository.get.bind(repository);
  repository.get = async (...args) => { reads += 1; return await original(...args); };
  const service = new IssuePlanService({
    repository,
    authorizer: { async authorize() { throw new Error("denied"); } },
  });
  await assert.rejects(() => service.approve(command()), /denied/);
  assert.equal(reads, 0);
  const valid = await setup();
  for (const override of [
    { reason: "" },
    { policyRevision: "wrong-policy" },
    { affectedItemIds: [] },
  ]) await assert.rejects(() => valid.service.approve(command(override)), IssuePlanApprovalError);
});
