import assert from "node:assert/strict";
import test from "node:test";

import { DemoIssuePlannerAdapter } from
  "../app/control-plane/adapters/demo-issue-planner-adapter.ts";
import { IssuePlanGenerationService } from
  "../app/control-plane/application/issue-plan-generation-service.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
};
const goal = {
  id: scope.goalId,
  ...scope,
  title: "Auditable plans",
  problemStatement: "Plans need contracts",
  desiredOutcome: "Every approved requirement becomes an executable Issue",
  nonGoals: ["Do not replace the execution engine"],
  constraints: [],
  status: "planning",
  version: 3,
  acceptanceCriteria: [{ id: "AC-01", position: 1, statement: "Issue is self-contained" }],
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};
const specification = {
  id: "00000000-0000-4000-8000-000000000004",
  ...scope,
  status: "approved",
  version: 2,
  artifactRef: "artifact://spec",
  artifactDigest: "a".repeat(64),
};
const bundle = {
  schemaVersion: "spec-bundle.v1",
  proposal: { summary: "s", value: "v", inScope: ["x"], outOfScope: ["n"], deliverySlices: ["d"] },
  prd: { problem: "p", users: ["u"], requirements: [{ id: "REQ-01", statement: "Create issue", acceptanceCriterionRefs: ["AC-01"] }], nonGoals: goal.nonGoals, constraints: [] },
  architecture: { summary: "a", components: [{ id: "C-1", name: "c", responsibility: "r", requirementRefs: ["REQ-01"] }], decisions: ["d"] },
  migration: { required: false, steps: [], verification: [] },
  rollback: { triggers: ["t"], steps: ["s"], dataRecovery: "r" },
  solutionElements: [{ id: "E-1", title: "e", kind: "product", description: "d", acceptanceCriterionRefs: ["AC-01"], constraintRefs: [], estimatedCost: "low", removalImpact: "i", evidence: ["REQ-01"] }],
};

test("P6-01 generates only from the latest approved specification and preserves source metadata", async () => {
  const calls = [];
  const service = new IssuePlanGenerationService({
    goals: { async get() { return goal; } },
    specifications: {
      async get() { return specification; },
      async getLatest() { return specification; },
    },
    artifacts: { async get() { return { ref: specification.artifactRef, digest: specification.artifactDigest, mediaType: "application/json", sizeBytes: 1, createdAt: goal.createdAt, createdBy: "actor", content: bundle }; } },
    planner: new DemoIssuePlannerAdapter(),
    plans: { async createDraft(command) { calls.push(command); return { plan: { id: "plan-1" } }; } },
    authorizer: { async authorize() {} },
  });
  const result = await service.generate({
    ...scope,
    specRevisionId: specification.id,
    expectedSpecVersion: 2,
    actorId: "approver-1",
  });
  assert.equal(result.plan.id, "plan-1");
  assert.equal(calls[0].source.specRevisionId, specification.id);
  assert.equal(calls[0].source.specArtifactDigest, specification.artifactDigest);
  assert.deepEqual(calls[0].source.requirements, [{ id: "REQ-01", acceptanceCriterionRefs: ["AC-01"] }]);
  assert.match(calls[0].draft.issues[0].developmentPrompt, /REQ-01/);
  assert.match(calls[0].draft.issues[0].developmentPrompt, /AC-01/);
  assert.match(calls[0].draft.issues[0].developmentPrompt, /Do not replace the execution engine/);
});

test("P6-01 authorizes generation before reading approved source material", async () => {
  let reads = 0;
  const service = new IssuePlanGenerationService({
    goals: { async get() { reads += 1; return goal; } },
    specifications: {
      async get() { reads += 1; return specification; },
      async getLatest() { reads += 1; return specification; },
    },
    artifacts: { async get() { reads += 1; return null; } },
    planner: new DemoIssuePlannerAdapter(),
    plans: { async createDraft() { throw new Error("must not run"); } },
    authorizer: { async authorize() { throw new Error("denied"); } },
  });
  await assert.rejects(() => service.generate({
    ...scope,
    specRevisionId: specification.id,
    expectedSpecVersion: 2,
    actorId: "viewer-1",
  }), /denied/);
  assert.equal(reads, 0);
});
