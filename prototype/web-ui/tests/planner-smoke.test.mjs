import assert from "node:assert/strict";
import test from "node:test";

import { CodexPlannerAdapter } from
  "../app/control-plane/adapters/codex-planner-adapter.ts";
import { ClarificationPlannerService } from
  "../app/control-plane/application/clarification-planner-service.ts";
import { SpecGenerationService } from
  "../app/control-plane/application/spec-generation-service.ts";
import { MemoryArtifactStore } from
  "../app/control-plane/adapters/memory-artifact-store.ts";
import { MemorySpecRevisionRepository } from
  "../app/control-plane/adapters/memory-spec-revision-repository.ts";
import { MemoryGoalWorkspaceRepository } from
  "../app/control-plane/adapters/memory-goal-workspace-repository.ts";

const smokeTest = process.env.RUN_CODEX_PLANNER_SMOKE === "1" ? test : test.skip;

smokeTest("runs one controlled real Codex Planner session", async () => {
  const service = new ClarificationPlannerService(
    new CodexPlannerAdapter({ timeoutMs: 120_000 }),
  );
  const result = await service.generate({
    id: "00000000-0000-4000-8000-000000000311",
    organizationId: "00000000-0000-4000-8000-000000000312",
    projectId: "00000000-0000-4000-8000-000000000313",
    title: "Verify the Planner adapter",
    problemStatement: "The subprocess contract needs one real smoke test.",
    desiredOutcome: "Return a short structured draft without reading a repository.",
    acceptanceCriteria: [{
      id: "00000000-0000-4000-8000-000000000314",
      position: 1,
      statement: "The result matches the supplied JSON Schema",
      version: 1,
    }],
    nonGoals: ["Modify files"],
    constraints: ["Read-only ephemeral session"],
    status: "clarifying",
    version: 1,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(result.status, "draft");
  assert.equal(result.sourceGoalVersion, 1);
  assert.equal(result.output.schemaVersion, "planner-clarification.v1");
  assert.ok(Array.isArray(result.output.knownFacts));
  assert.ok(Array.isArray(result.output.uncertainties));
  assert.ok(Array.isArray(result.output.questions));
});

smokeTest("runs one controlled real specification generation session", async () => {
  const goal = {
    id: "00000000-0000-4000-8000-000000000321",
    organizationId: "00000000-0000-4000-8000-000000000322",
    projectId: "00000000-0000-4000-8000-000000000323",
    title: "Verify immutable specification generation",
    problemStatement: "The specification pipeline needs one real Planner smoke test.",
    desiredOutcome: "Produce a strict Proposal and PRD artifact without modifying a repository.",
    acceptanceCriteria: [{
      id: "00000000-0000-4000-8000-000000000324",
      position: 1,
      statement: "The generated output is strict, traceable, and immutable",
      version: 1,
    }],
    nonGoals: ["Compile Issues", "Modify files"],
    constraints: ["Read-only ephemeral Planner session"],
    status: "planning",
    version: 1,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
  const service = new SpecGenerationService({
    planner: new CodexPlannerAdapter({ timeoutMs: 120_000 }),
    artifacts: new MemoryArtifactStore(),
    repository: new MemorySpecRevisionRepository(),
    goals: new MemoryGoalWorkspaceRepository([goal]),
    authorizer: { async authorize() {} },
  });
  const result = await service.generate({
    organizationId: goal.organizationId,
    projectId: goal.projectId,
    goalId: goal.id,
    actorId: "smoke-test",
    expectedGoalVersion: goal.version,
    reason: "Controlled real Planner smoke test",
  });
  assert.equal(result.specRevision.revision, 1);
  assert.equal(result.artifact.content.schemaVersion, "spec-bundle.v1");
  assert.match(result.artifact.digest, /^[0-9a-f]{64}$/);
});
