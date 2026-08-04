import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compileIssuePlan } from
  "../app/control-plane/domain/issue-compiler.ts";
import { validateIssuePlanDraft } from
  "../app/control-plane/domain/issue-plan.ts";

const golden = validateIssuePlanDraft(JSON.parse(readFileSync(new URL(
  "fixtures/issue-plan/v1-golden.json",
  import.meta.url,
), "utf8")));
const source = {
  requirements: [
    { id: "REQ-01", acceptanceCriterionRefs: ["AC-01"] },
    { id: "REQ-02", acceptanceCriterionRefs: ["AC-02"] },
  ],
  acceptanceCriterionIds: ["AC-01", "AC-02"],
};

test("P6-02 proves bidirectional requirement and acceptance coverage", () => {
  const result = compileIssuePlan({ ...source, issues: golden.issues });
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.coverage.requirements, {
    covered: ["REQ-01", "REQ-02"],
    uncovered: [],
  });
  assert.deepEqual(result.coverage.acceptanceCriteria, {
    covered: ["AC-01", "AC-02"],
    uncovered: [],
  });
  assert.deepEqual(result.topologicalOrder, ["DEV-01", "DEV-02"]);
});

test("P6-02 reports unknown refs, orphans, missing deps, self deps, and duplicate edges", () => {
  const issues = structuredClone(golden.issues);
  issues[0].requirementRefs = ["REQ-404"];
  issues[0].acceptance = [];
  issues[0].dependencyCandidates = ["DEV-404", "DEV-01"];
  issues[1].requirementRefs = [];
  issues[1].acceptance = [];
  issues[1].dependencyCandidates = ["DEV-01", "DEV-01"];
  const result = compileIssuePlan({ ...source, issues });
  assert.equal(result.valid, false);
  const codes = new Set(result.diagnostics.map(({ code }) => code));
  for (const code of [
    "unknown_requirement_ref",
    "orphan_issue",
    "missing_dependency",
    "self_dependency",
    "duplicate_dependency",
    "uncovered_requirement",
    "uncovered_acceptance",
  ]) assert.ok(codes.has(code), code);
  assert.ok(result.diagnostics.every(({ path, impact }) => path && impact));
});

test("P6-02 returns the exact cycle and blocks compilation", () => {
  const issues = structuredClone(golden.issues);
  issues[0].dependencyCandidates = ["DEV-02"];
  issues[1].dependencyCandidates = ["DEV-01"];
  const result = compileIssuePlan({ ...source, issues });
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.diagnostics.find(({ code }) => code === "dependency_cycle")?.relatedIssueKeys,
    ["DEV-01", "DEV-02", "DEV-01"],
  );
});

test("P6-02 accepts deterministic generated DAGs and rejects a generated back edge", () => {
  let seed = 17;
  const random = () => ((seed = (seed * 48271) % 0x7fffffff) / 0x7fffffff);
  const issues = Array.from({ length: 40 }, (_, index) => ({
    ...structuredClone(golden.issues[0]),
    key: `RND-${String(index + 1).padStart(2, "0")}`,
    requirementRefs: ["REQ-01"],
    acceptance: [{ criterionRef: "AC-01", statement: "covered" }],
    dependencyCandidates: Array.from({ length: index }, (_, prior) => prior)
      .filter(() => random() < 0.08)
      .map((prior) => `RND-${String(prior + 1).padStart(2, "0")}`),
  }));
  let result = compileIssuePlan({
    requirements: [{ id: "REQ-01", acceptanceCriterionRefs: ["AC-01"] }],
    acceptanceCriterionIds: ["AC-01"],
    issues,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.topologicalOrder, [...result.topologicalOrder].sort((a, b) => {
    const ia = result.topologicalOrder.indexOf(a);
    const ib = result.topologicalOrder.indexOf(b);
    return ia - ib;
  }));
  issues[0].dependencyCandidates = [issues.at(-1).key];
  issues.at(-1).dependencyCandidates = [...issues.at(-1).dependencyCandidates, issues[0].key];
  result = compileIssuePlan({
    requirements: [{ id: "REQ-01", acceptanceCriterionRefs: ["AC-01"] }],
    acceptanceCriterionIds: ["AC-01"],
    issues,
  });
  assert.ok(result.diagnostics.some(({ code }) => code === "dependency_cycle"));
});
