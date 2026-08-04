import assert from "node:assert/strict";
import test from "node:test";

import { preserveSpecReviewDraft } from
  "../app/workbench/spec-review-draft.ts";

test("preserves approval reason, Helpful exceptions, and scope input across failures", () => {
  const original = {
    reason: "Keep this exact human rationale",
    helpfulExceptionElementIds: ["EL-HELP"],
    scopeChange: {
      operation: "add",
      kind: "constraint",
      value: "Preserve regional residency",
    },
  };
  const conflictDraft = preserveSpecReviewDraft(original);
  const networkDraft = preserveSpecReviewDraft(original);
  original.helpfulExceptionElementIds.push("EL-LATER");
  original.scopeChange.value = "mutated";

  for (const restored of [conflictDraft, networkDraft]) {
    assert.deepEqual(restored, {
      reason: "Keep this exact human rationale",
      helpfulExceptionElementIds: ["EL-HELP"],
      scopeChange: {
        operation: "add",
        kind: "constraint",
        value: "Preserve regional residency",
      },
    });
  }
});
