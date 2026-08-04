import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  issuePlanDraftOutputSchema,
  issuePlanDraftSchemaVersion,
  validateIssuePlanDraft,
  IssuePlanValidationError,
} from "../app/control-plane/domain/issue-plan.ts";

const golden = JSON.parse(readFileSync(new URL(
  "fixtures/issue-plan/v1-golden.json",
  import.meta.url,
), "utf8"));

test("P6-01 exposes a closed, versioned Issue draft schema", () => {
  assert.equal(issuePlanDraftSchemaVersion, "issue-plan-draft.v1");
  assert.equal(issuePlanDraftOutputSchema.additionalProperties, false);
  assert.equal(issuePlanDraftOutputSchema.properties.issues.items.additionalProperties, false);
  assert.deepEqual(validateIssuePlanDraft(golden), golden);
});

test("P6-01 requires a self-contained prompt and completion evidence", () => {
  const validated = validateIssuePlanDraft(golden);
  for (const issue of validated.issues) {
    assert.match(issue.developmentPrompt, new RegExp(issue.goal));
    for (const item of issue.acceptance) {
      assert.match(issue.developmentPrompt, new RegExp(item.criterionRef));
      assert.match(issue.developmentPrompt, new RegExp(item.statement));
    }
  }
  for (const field of [
    "goal",
    "requirementRefs",
    "acceptance",
    "nonGoals",
    "dependencyCandidates",
    "expectedFiles",
    "developmentPrompt",
    "verify",
    "completionEvidence",
  ]) {
    const invalid = structuredClone(golden);
    delete invalid.issues[0][field];
    assert.throws(
      () => validateIssuePlanDraft(invalid),
      (error) => error instanceof IssuePlanValidationError,
      field,
    );
  }
});

test("P6-01 rejects unknown fields, duplicate keys, weak prompts, and incomplete evidence", () => {
  const cases = [];
  const unknown = structuredClone(golden);
  unknown.issues[0].model = "gpt-secret-name";
  cases.push(unknown);
  const duplicate = structuredClone(golden);
  duplicate.issues[1].key = duplicate.issues[0].key;
  cases.push(duplicate);
  const weakPrompt = structuredClone(golden);
  weakPrompt.issues[0].developmentPrompt = "Implement it";
  cases.push(weakPrompt);
  const missingAcceptanceMeaning = structuredClone(golden);
  missingAcceptanceMeaning.issues[0].developmentPrompt =
    missingAcceptanceMeaning.issues[0].developmentPrompt.replace(
      missingAcceptanceMeaning.issues[0].acceptance[0].statement,
      "the referenced criterion",
    );
  cases.push(missingAcceptanceMeaning);
  const noRequiredEvidence = structuredClone(golden);
  noRequiredEvidence.issues[0].completionEvidence[0].required = false;
  cases.push(noRequiredEvidence);
  for (const value of cases) {
    assert.throws(() => validateIssuePlanDraft(value), IssuePlanValidationError);
  }
});
