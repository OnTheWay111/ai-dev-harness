import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifySolutionElements,
  overdesignPolicyRevision,
  overdesignReviewSchemaVersion,
} from "../app/control-plane/domain/overdesign-review.ts";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/overdesign/v1-golden.json", import.meta.url),
  "utf8",
));

test("golden solution elements produce stable Required, Helpful, and Speculative results", () => {
  const first = classifySolutionElements(fixture.goal, fixture.elements);
  const second = classifySolutionElements(fixture.goal, fixture.elements);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, overdesignReviewSchemaVersion);
  assert.equal(first.policyRevision, overdesignPolicyRevision);
  assert.deepEqual(first.items.map(({ category }) => category), fixture.expectedCategories);
  assert.deepEqual(first.counts, { Required: 1, Helpful: 1, Speculative: 1 });
});

test("an element without a valid acceptance-criterion trace can never become Required", () => {
  const review = classifySolutionElements(
    { acceptanceCriterionIds: ["ac-1"], constraints: ["Audit"] },
    [
      { ...fixture.elements[0], acceptanceCriterionRefs: [] },
      { ...fixture.elements[0], id: "EL-UNKNOWN", acceptanceCriterionRefs: ["missing"] },
      {
        ...fixture.elements[1],
        id: "EL-NO-EVIDENCE",
        constraintRefs: ["Audit"],
        evidence: [],
      },
    ],
  );
  assert.deepEqual(
    review.items.map(({ category }) => category),
    ["Speculative", "Speculative", "Speculative"],
  );
  assert.ok(review.items.every(({ requirementRefs }) => requirementRefs.length === 0));
});

test("review output retains requirement references, cost, removal impact, and evidence", () => {
  const review = classifySolutionElements(fixture.goal, fixture.elements);
  assert.deepEqual(review.items[0], {
    elementId: "EL-REQ",
    title: "Approval gate",
    category: "Required",
    requirementRefs: ["ac-1"],
    constraintRefs: [],
    estimatedCost: "medium",
    removalImpact: "Unapproved plans could compile.",
    evidence: ["REQ-1"],
    rationale: "Directly traces to 1 approved acceptance criterion.",
  });
});

test("UI explains every classification and the deterministic policy boundary", () => {
  const source = readFileSync(new URL(
    "../app/workbench/components/overdesign-review-panel.tsx",
    import.meta.url,
  ), "utf8");
  assert.match(source, /Required/);
  assert.match(source, /Helpful/);
  assert.match(source, /Speculative/);
  assert.match(source, /elementId/);
  assert.match(source, /estimatedCost|预估成本/i);
  assert.match(source, /模型不能决定门禁/);
  assert.match(source, /policyRevision/);
});
