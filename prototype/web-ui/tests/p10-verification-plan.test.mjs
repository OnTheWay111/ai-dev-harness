import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  acceptanceVerificationPlanDraftOutputSchema,
  acceptanceVerificationPlanDraftSchemaVersion,
  AcceptanceVerificationPlanValidationError,
  compileAcceptanceVerificationPlan,
  validateAcceptanceVerificationPlanDraft,
} from "../app/control-plane/domain/acceptance-verification.ts";

const golden = JSON.parse(readFileSync(new URL(
  "fixtures/verification-plan/v1-golden.json",
  import.meta.url,
), "utf8"));

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
};
const criteria = [
  { id: golden.entries[0].criterionRef, position: 1, statement: "All P10 tests pass.", version: 1 },
  { id: golden.entries[1].criterionRef, position: 2, statement: "Immutable evidence is retained.", version: 1 },
  { id: golden.entries[2].criterionRef, position: 3, statement: "A recovery drill is accepted.", version: 1 },
];
const references = {
  command: [golden.entries[0].strategy.reference],
  query: ["query:issues:completed"],
  artifact: [golden.entries[1].strategy.reference],
};

test("P10-01 exposes a closed, versioned verification-plan schema and compiles a golden plan", async () => {
  assert.equal(
    acceptanceVerificationPlanDraftSchemaVersion,
    "acceptance-verification-plan-draft.v1",
  );
  assert.equal(acceptanceVerificationPlanDraftOutputSchema.additionalProperties, false);
  assert.equal(
    acceptanceVerificationPlanDraftOutputSchema.properties.entries.items.additionalProperties,
    false,
  );
  assert.deepEqual(validateAcceptanceVerificationPlanDraft(golden), golden);
  const plan = await compileAcceptanceVerificationPlan({
    ...scope,
    goalVersion: 7,
    issuePlanId: "00000000-0000-4000-8000-000000000004",
    issuePlanVersion: 2,
    criteria,
    draft: golden,
    availableReferences: references,
    revision: 1,
    id: "00000000-0000-4000-8000-000000000005",
    compiledAt: "2026-08-05T08:00:00.000Z",
  });
  assert.equal(plan.compilation.valid, true);
  assert.equal(plan.entries.length, criteria.length);
  assert.match(plan.digest, /^[0-9a-f]{64}$/);
  assert.equal(plan.entries.at(-1).strategy.type, "manual");
});

test("P10-01 rejects missing, duplicate, and unknown criterion or evidence references", async () => {
  const cases = [];
  const missing = structuredClone(golden);
  missing.entries.pop();
  cases.push(missing);
  const duplicate = structuredClone(golden);
  duplicate.entries[1].criterionRef = duplicate.entries[0].criterionRef;
  cases.push(duplicate);
  const unknownCriterion = structuredClone(golden);
  unknownCriterion.entries[0].criterionRef = crypto.randomUUID();
  cases.push(unknownCriterion);
  const unknownEvidence = structuredClone(golden);
  unknownEvidence.entries[0].strategy.reference = "command:not-approved";
  cases.push(unknownEvidence);
  for (const draft of cases) {
    await assert.rejects(
      () => compileAcceptanceVerificationPlan({
        ...scope,
        goalVersion: 7,
        issuePlanId: crypto.randomUUID(),
        issuePlanVersion: 2,
        criteria,
        draft,
        availableReferences: references,
        revision: 1,
        id: crypto.randomUUID(),
        compiledAt: "2026-08-05T08:00:00.000Z",
      }),
      AcceptanceVerificationPlanValidationError,
    );
  }
});

test("P10-01 forbids vague, unowned, unbounded, or auto-approved manual checks", () => {
  for (const mutate of [
    (value) => { value.entries[0].successCondition = "looks good"; },
    (value) => { value.entries[0].responsibleParty = ""; },
    (value) => { value.entries[0].timeoutMs = 0; },
    (value) => { value.entries[2].strategy.requiredRole = "operator"; },
    (value) => { value.entries[0].strategy.extra = "shell text"; },
  ]) {
    const invalid = structuredClone(golden);
    mutate(invalid);
    assert.throws(
      () => validateAcceptanceVerificationPlanDraft(invalid),
      AcceptanceVerificationPlanValidationError,
    );
  }
});
