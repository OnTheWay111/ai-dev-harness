import assert from "node:assert/strict";
import test from "node:test";

import { diffSpecBundles } from
  "../app/control-plane/domain/spec-revision-diff.ts";

function bundle() {
  return {
    schemaVersion: "spec-bundle.v1",
    proposal: {
      summary: "First proposal",
      value: "Ship the smallest safe contract",
      inScope: ["Approval"],
      outOfScope: ["Execution"],
      deliverySlices: ["API"],
    },
    prd: {
      problem: "Specs cannot be reviewed",
      users: ["Approver"],
      requirements: [{
        id: "REQ-1",
        statement: "Compare immutable revisions",
        acceptanceCriterionRefs: ["AC-1"],
      }],
      nonGoals: ["Issue compiler"],
      constraints: ["No overwrite"],
    },
    architecture: { summary: "One module", components: [], decisions: [] },
    migration: { required: false, steps: [], verification: [] },
    rollback: { triggers: ["Failure"], steps: ["Revert"], dataRecovery: "None" },
    solutionElements: [],
  };
}

test("computes stable Proposal and PRD additions, removals, and edits", () => {
  const before = bundle();
  const after = structuredClone(before);
  after.proposal.summary = "Revised proposal";
  after.proposal.inScope.push("Revision diff");
  after.proposal.outOfScope = [];
  after.prd.requirements[0].statement = "Compare adjacent immutable revisions";
  after.prd.requirements.push({
    id: "REQ-2",
    statement: "Preserve approval drafts on conflicts",
    acceptanceCriterionRefs: ["AC-2"],
  });

  const diff = diffSpecBundles(before, after);
  assert.deepEqual(diff.counts, { added: 2, removed: 1, changed: 2 });
  assert.deepEqual(
    diff.changes.map(({ section, path, kind }) => ({ section, path, kind })),
    [
      { section: "proposal", path: "proposal.summary", kind: "changed" },
      { section: "proposal", path: "proposal.inScope", kind: "added" },
      { section: "proposal", path: "proposal.outOfScope", kind: "removed" },
      { section: "prd", path: "prd.requirements.REQ-1.statement", kind: "changed" },
      { section: "prd", path: "prd.requirements.REQ-2", kind: "added" },
    ],
  );
});

test("identical revisions produce an explicit empty diff", () => {
  assert.deepEqual(diffSpecBundles(bundle(), bundle()), {
    changes: [],
    counts: { added: 0, removed: 0, changed: 0 },
  });
});
