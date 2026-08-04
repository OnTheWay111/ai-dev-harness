import assert from "node:assert/strict";
import test from "node:test";

import { CodexPlannerAdapter } from
  "../app/control-plane/adapters/codex-planner-adapter.ts";

const smokeTest = process.env.RUN_CODEX_PLANNER_SMOKE === "1" ? test : test.skip;

smokeTest("runs one controlled real Codex Planner session", async () => {
  const adapter = new CodexPlannerAdapter({ timeoutMs: 120_000 });
  const result = await adapter.plan({
    goal: {
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
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  });
  assert.equal(result.status, "draft");
  assert.equal(result.sourceGoalVersion, 1);
  assert.equal(typeof result.output.summary, "string");
  assert.ok(result.output.summary.length > 0);
});
