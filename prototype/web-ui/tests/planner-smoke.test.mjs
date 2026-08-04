import assert from "node:assert/strict";
import test from "node:test";

import { CodexPlannerAdapter } from
  "../app/control-plane/adapters/codex-planner-adapter.ts";
import { ClarificationPlannerService } from
  "../app/control-plane/application/clarification-planner-service.ts";

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
