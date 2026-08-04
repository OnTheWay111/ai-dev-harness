import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  plannerClarificationOutputSchema,
  PlannerOutputValidationError,
  validatePlannerClarificationOutput,
} from "../app/control-plane/domain/planner-clarification-schema.ts";
import {
  ClarificationPlannerService,
} from "../app/control-plane/application/clarification-planner-service.ts";
import { FakePlannerAdapter } from
  "../app/control-plane/adapters/fake-planner-adapter.ts";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(
    `./fixtures/planner-output/${name}`,
    import.meta.url,
  ), "utf8"));
}

const goal = {
  id: "00000000-0000-4000-8000-000000000401",
  organizationId: "00000000-0000-4000-8000-000000000402",
  projectId: "00000000-0000-4000-8000-000000000403",
  title: "Validate clarification output",
  problemStatement: "Free-form model output cannot be authoritative.",
  desiredOutcome: "Accept only the versioned Planner JSON contract.",
  acceptanceCriteria: [{ id: "ac-1", position: 1, statement: "Reject extra fields", version: 1 }],
  nonGoals: ["Guess malformed output"],
  constraints: ["Fail closed"],
  status: "clarifying",
  version: 4,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

test("publishes a closed versioned JSON Schema for every Planner field", () => {
  assert.equal(plannerClarificationOutputSchema.additionalProperties, false);
  assert.deepEqual(
    plannerClarificationOutputSchema.properties.schemaVersion.enum,
    ["planner-clarification.v1"],
  );
  assert.deepEqual(plannerClarificationOutputSchema.required, [
    "schemaVersion",
    "knownFacts",
    "uncertainties",
    "questions",
  ]);
  for (const collection of ["knownFacts", "uncertainties", "questions"]) {
    assert.equal(
      plannerClarificationOutputSchema.properties[collection].items.additionalProperties,
      false,
    );
  }
  assert.deepEqual(
    plannerClarificationOutputSchema.properties.questions.items.required,
    ["id", "prompt", "rationale", "blockingLevel", "answerType", "suggestedOptions"],
  );
});

test("accepts the v1 fixture and returns a detached validated value", async () => {
  const input = await fixture("v1-valid.json");
  const output = validatePlannerClarificationOutput(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
});

test("rejects extra, missing, incompatible, and malformed values without guessing", async () => {
  const malformed = await fixture("v1-malformed-extra.json");
  const candidates = [
    malformed,
    { ...(await fixture("v1-valid.json")), schemaVersion: "planner-clarification.v2" },
    { ...(await fixture("v1-valid.json")), questions: [{ id: "question-1" }] },
    {
      ...(await fixture("v1-valid.json")),
      questions: [{
        ...(await fixture("v1-valid.json")).questions[0],
        blockingLevel: "critical-ish",
      }],
    },
  ];
  for (const candidate of candidates) {
    assert.throws(
      () => validatePlannerClarificationOutput(candidate),
      (error) => error instanceof PlannerOutputValidationError &&
        error.code === "planner_schema_invalid" && error.issues.length > 0,
    );
  }
});

test("validation diagnostics contain paths and codes but never rejected content", () => {
  const secret = "do-not-log-this-value";
  assert.throws(
    () => validatePlannerClarificationOutput({ secret }),
    (error) => {
      assert.ok(error instanceof PlannerOutputValidationError);
      assert.doesNotMatch(error.message + JSON.stringify(error.issues), new RegExp(secret));
      assert.deepEqual(Object.keys(error.issues[0]).sort(), ["code", "path"]);
      return true;
    },
  );
});

test("Planner service always supplies the v1 schema and validates before returning", async () => {
  const valid = await fixture("v1-valid.json");
  const fake = new FakePlannerAdapter([valid]);
  const service = new ClarificationPlannerService(fake);
  const draft = await service.generate(goal);
  assert.equal(draft.status, "draft");
  assert.equal(draft.sourceGoalVersion, 4);
  assert.deepEqual(draft.output, valid);

  const invalidService = new ClarificationPlannerService(
    new FakePlannerAdapter([{ ...valid, unexpected: true }]),
  );
  await assert.rejects(
    () => invalidService.generate(goal),
    PlannerOutputValidationError,
  );
});
