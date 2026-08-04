import assert from "node:assert/strict";
import test from "node:test";

import { MemorySpecRevisionRepository } from
  "../app/control-plane/adapters/memory-spec-revision-repository.ts";
import {
  SpecApprovalService,
  SpecApprovalValidationError,
} from "../app/control-plane/application/spec-approval-service.ts";
import {
  IdempotencyConflictError,
  VersionConflictError,
} from "../app/control-plane/domain/errors.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
};

function spec(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000004",
    ...scope,
    revision: 1,
    previousRevisionId: null,
    status: "in_review",
    sourceGoalVersion: 3,
    artifactRef: "artifact://sha256/" + "a".repeat(64),
    artifactDigest: "a".repeat(64),
    artifactMediaType: "application/json",
    artifactSizeBytes: 123,
    plannerRunId: "planner-run-1",
    plannerConfiguration: {
      adapter: "fake",
      modelProfile: "test",
      schemaVersion: "spec-bundle.v1",
    },
    overdesignPolicyRevision: "overdesign-policy.v1",
    overdesignReview: {
      schemaVersion: "overdesign-review.v1",
      policyRevision: "overdesign-policy.v1",
      counts: { Required: 1, Helpful: 1, Speculative: 1 },
      items: [
        {
          elementId: "EL-REQ",
          title: "Required gate",
          category: "Required",
          requirementRefs: ["ac-1"],
          constraintRefs: [],
          estimatedCost: "medium",
          removalImpact: "Acceptance fails",
          evidence: ["REQ-1"],
          rationale: "Required",
        },
        {
          elementId: "EL-HELP",
          title: "Helpful rollout guard",
          category: "Helpful",
          requirementRefs: [],
          constraintRefs: ["Zero downtime"],
          estimatedCost: "low",
          removalImpact: "Rollout is less safe",
          evidence: ["ADR-1"],
          rationale: "Helpful",
        },
        {
          elementId: "EL-SPEC",
          title: "Speculative designer",
          category: "Speculative",
          requirementRefs: [],
          constraintRefs: [],
          estimatedCost: "high",
          removalImpact: "No approved requirement changes",
          evidence: [],
          rationale: "Speculative",
        },
      ],
    },
    generatedAt: "2026-08-04T02:00:00.000Z",
    version: 1,
    createdAt: "2026-08-04T02:00:00.000Z",
    updatedAt: "2026-08-04T02:00:00.000Z",
    ...overrides,
  };
}

async function setup(options = {}) {
  const repository = new MemorySpecRevisionRepository([spec()]);
  const service = new SpecApprovalService({
    repository,
    authorizer: options.authorizer ?? { async authorize() {} },
    clock: () => new Date("2026-08-04T04:00:00.000Z"),
    idGenerator: (() => {
      let value = 10;
      return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
    })(),
  });
  return { repository, service };
}

function command(overrides = {}) {
  return {
    scope,
    target: { type: "spec_revision", id: spec().id },
    expectedVersion: 1,
    actorId: "approver-1",
    reason: "Approve the minimum execution contract",
    requestId: "request-1",
    idempotencyKey: "idempotency-1",
    policyRevision: "overdesign-policy.v1",
    decision: "approve",
    affectedItemIds: ["EL-REQ", "EL-HELP", "EL-SPEC"],
    payload: {
      helpfulExceptionElementIds: ["EL-HELP"],
      scopeChanges: [],
    },
    ...overrides,
  };
}

test("approval retains Required and explicit Helpful exceptions but always deletes Speculative", async () => {
  const { repository, service } = await setup();
  const receipt = await service.decide(command());
  assert.equal(receipt.target.type, "spec_revision");
  assert.equal(receipt.previousVersion, 1);
  assert.equal(receipt.currentVersion, 2);
  assert.equal(receipt.result.specRevision.status, "approved");
  assert.equal(receipt.result.specRevision.version, 2);
  assert.deepEqual(receipt.result.retainedElementIds, ["EL-REQ", "EL-HELP"]);
  assert.deepEqual(receipt.result.removedElementIds, ["EL-SPEC"]);
  assert.equal(receipt.actorId, "approver-1");
  assert.equal(receipt.reason, command().reason);
  assert.equal(receipt.requestId, "request-1");
  assert.equal(receipt.policyRevision, "overdesign-policy.v1");
  assert.match(receipt.receiptId, /^[0-9a-f-]{36}$/);
  assert.equal(receipt.result.decisionRecord.actorId, "approver-1");
  assert.equal(repository.committedAuditEvents.length, 1);
  assert.equal(repository.committedEvents.length, 1);
});

test("a draft can be submitted for review before the human decision", async () => {
  const repository = new MemorySpecRevisionRepository([spec({ status: "draft" })]);
  const service = new SpecApprovalService({ repository, authorizer: { async authorize() {} } });
  const receipt = await service.decide(command({
    decision: "submit_for_review",
    reason: "Artifact digest and deterministic review are ready",
    payload: { helpfulExceptionElementIds: [], scopeChanges: [] },
  }));
  assert.equal(receipt.result.specRevision.status, "in_review");
  assert.deepEqual(receipt.result.retainedElementIds, []);
  assert.deepEqual(receipt.result.removedElementIds, []);
  assert.equal(receipt.decision, "submit_for_review");
});

test("Helpful is removed without an exception and Speculative cannot be retained", async () => {
  const first = await setup();
  const receipt = await first.service.decide(command({
    payload: { helpfulExceptionElementIds: [], scopeChanges: [] },
  }));
  assert.deepEqual(receipt.result.retainedElementIds, ["EL-REQ"]);
  assert.deepEqual(receipt.result.removedElementIds, ["EL-HELP", "EL-SPEC"]);

  const second = await setup();
  await assert.rejects(
    () => second.service.decide(command({
      payload: { helpfulExceptionElementIds: ["EL-SPEC"], scopeChanges: [] },
    })),
    (error) => error instanceof SpecApprovalValidationError,
  );
});

test("scope change and rejection decisions append reasons and affected items", async () => {
  for (const [decision, scopeChanges] of [
    ["request_changes", [{ operation: "add", kind: "constraint", value: "Regional data residency" }]],
    ["reject", []],
  ]) {
    const { service } = await setup();
    const receipt = await service.decide(command({
      decision,
      idempotencyKey: `idempotency-${decision}`,
      payload: { scopeChanges, helpfulExceptionElementIds: [] },
    }));
    assert.equal(receipt.result.specRevision.status, "rejected");
    assert.equal(receipt.decision, decision);
    assert.deepEqual(receipt.result.decisionRecord.scopeChanges, scopeChanges);
    assert.deepEqual(
      receipt.result.decisionRecord.affectedElementIds,
      command().affectedItemIds,
    );
  }
});

test("authorization, blank reasons, stale versions, and changed policy fail closed", async () => {
  let reads = 0;
  const denied = await setup({
    authorizer: { async authorize() { throw new Error("denied"); } },
  });
  const originalGet = denied.repository.get.bind(denied.repository);
  denied.repository.get = async (...args) => { reads += 1; return await originalGet(...args); };
  await assert.rejects(() => denied.service.decide(command()), /denied/);
  assert.equal(reads, 0);

  for (const overrides of [
    { reason: "" },
    { expectedVersion: 2 },
    { policyRevision: "overdesign-policy.v0" },
  ]) {
    const { service } = await setup();
    await assert.rejects(
      () => service.decide(command(overrides)),
      (error) => error instanceof SpecApprovalValidationError ||
        error instanceof VersionConflictError,
    );
  }
});

test("an older SpecRevision cannot be approved after a replacement exists", async () => {
  const latestId = "00000000-0000-4000-8000-000000000005";
  const repository = new MemorySpecRevisionRepository([
    spec(),
    spec({
      id: latestId,
      revision: 2,
      previousRevisionId: spec().id,
      status: "draft",
    }),
  ]);
  const service = new SpecApprovalService({
    repository,
    authorizer: { async authorize() {} },
  });
  await assert.rejects(
    () => service.decide(command()),
    (error) => error instanceof VersionConflictError,
  );
  assert.deepEqual((await repository.approvalTimeline({
    ...scope,
    specRevisionId: spec().id,
  })).decisions, []);
});

test("the unified approval command fails closed when any mandatory field is missing", async () => {
  for (const field of [
    "target",
    "expectedVersion",
    "actorId",
    "reason",
    "requestId",
    "idempotencyKey",
    "policyRevision",
    "decision",
    "affectedItemIds",
    "payload",
  ]) {
    const invalid = command();
    delete invalid[field];
    const { service } = await setup();
    await assert.rejects(
      () => service.decide(invalid),
      (error) => error instanceof SpecApprovalValidationError,
      field,
    );
  }
});

test("identical retries replay once while key reuse and concurrent stale writes fail", async () => {
  const { repository, service } = await setup();
  const first = await service.decide(command());
  assert.deepEqual(await service.decide(command()), first);
  assert.equal(repository.committedAuditEvents.length, 1);
  assert.equal((await repository.approvalTimeline({
    ...scope,
    specRevisionId: spec().id,
  })).decisions.length, 1);
  await assert.rejects(
    () => service.decide(command({ reason: "Different command" })),
    (error) => error instanceof IdempotencyConflictError,
  );

  const concurrent = await setup();
  const results = await Promise.allSettled([
    concurrent.service.decide(command({ idempotencyKey: "race-a" })),
    concurrent.service.decide(command({ idempotencyKey: "race-b" })),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
});

test("an empty rejection reason is rejected before any decision is appended", async () => {
  const { repository, service } = await setup();
  await assert.rejects(
    () => service.decide(command({ decision: "reject", reason: "" })),
    (error) => error instanceof SpecApprovalValidationError,
  );
  assert.deepEqual((await repository.approvalTimeline({
    ...scope,
    specRevisionId: spec().id,
  })).decisions, []);
});
