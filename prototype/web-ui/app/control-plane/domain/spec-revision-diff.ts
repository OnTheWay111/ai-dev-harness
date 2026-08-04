import type { SpecBundle } from "./spec-artifact.ts";

export const specDiffSections = [
  "proposal",
  "prd",
  "architecture",
  "migration",
  "rollback",
  "solutionElements",
] as const;

export type SpecDiffSection = (typeof specDiffSections)[number];
export type SpecDiffKind = "added" | "removed" | "changed";

export interface SpecFieldChange {
  section: SpecDiffSection;
  path: string;
  kind: SpecDiffKind;
  before: string | null;
  after: string | null;
}

export interface SpecRevisionDiff {
  changes: readonly SpecFieldChange[];
  counts: Readonly<Record<SpecDiffKind, number>>;
}

function printable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function compareValue(
  changes: SpecFieldChange[],
  section: SpecDiffSection,
  path: string,
  before: unknown,
  after: unknown,
) {
  const left = printable(before);
  const right = printable(after);
  if (left === right) return;
  changes.push({ section, path, kind: "changed", before: left, after: right });
}

function compareList(
  changes: SpecFieldChange[],
  section: SpecDiffSection,
  path: string,
  before: readonly string[],
  after: readonly string[],
) {
  const left = new Set(before);
  const right = new Set(after);
  for (const value of before) {
    if (!right.has(value)) changes.push({
      section,
      path,
      kind: "removed",
      before: value,
      after: null,
    });
  }
  for (const value of after) {
    if (!left.has(value)) changes.push({
      section,
      path,
      kind: "added",
      before: null,
      after: value,
    });
  }
}

export function diffSpecBundles(before: SpecBundle, after: SpecBundle): SpecRevisionDiff {
  const changes: SpecFieldChange[] = [];
  compareValue(changes, "proposal", "proposal.summary", before.proposal.summary, after.proposal.summary);
  compareValue(changes, "proposal", "proposal.value", before.proposal.value, after.proposal.value);
  compareList(changes, "proposal", "proposal.inScope", before.proposal.inScope, after.proposal.inScope);
  compareList(changes, "proposal", "proposal.outOfScope", before.proposal.outOfScope, after.proposal.outOfScope);
  compareList(changes, "proposal", "proposal.deliverySlices", before.proposal.deliverySlices, after.proposal.deliverySlices);

  compareValue(changes, "prd", "prd.problem", before.prd.problem, after.prd.problem);
  compareList(changes, "prd", "prd.users", before.prd.users, after.prd.users);
  compareList(changes, "prd", "prd.nonGoals", before.prd.nonGoals, after.prd.nonGoals);
  compareList(changes, "prd", "prd.constraints", before.prd.constraints, after.prd.constraints);
  const beforeRequirements = new Map(before.prd.requirements.map((item) => [item.id, item]));
  const afterRequirements = new Map(after.prd.requirements.map((item) => [item.id, item]));
  for (const requirement of before.prd.requirements) {
    const current = afterRequirements.get(requirement.id);
    if (!current) {
      changes.push({
        section: "prd",
        path: `prd.requirements.${requirement.id}`,
        kind: "removed",
        before: printable(requirement),
        after: null,
      });
      continue;
    }
    compareValue(
      changes,
      "prd",
      `prd.requirements.${requirement.id}.statement`,
      requirement.statement,
      current.statement,
    );
    compareList(
      changes,
      "prd",
      `prd.requirements.${requirement.id}.acceptanceCriterionRefs`,
      requirement.acceptanceCriterionRefs,
      current.acceptanceCriterionRefs,
    );
  }
  for (const requirement of after.prd.requirements) {
    if (!beforeRequirements.has(requirement.id)) changes.push({
      section: "prd",
      path: `prd.requirements.${requirement.id}`,
      kind: "added",
      before: null,
      after: printable(requirement),
    });
  }

  compareValue(changes, "architecture", "architecture.summary", before.architecture.summary, after.architecture.summary);
  compareValue(changes, "architecture", "architecture.components", before.architecture.components, after.architecture.components);
  compareList(changes, "architecture", "architecture.decisions", before.architecture.decisions, after.architecture.decisions);
  compareValue(changes, "migration", "migration", before.migration, after.migration);
  compareValue(changes, "rollback", "rollback", before.rollback, after.rollback);
  compareValue(changes, "solutionElements", "solutionElements", before.solutionElements, after.solutionElements);

  return {
    changes,
    counts: {
      added: changes.filter(({ kind }) => kind === "added").length,
      removed: changes.filter(({ kind }) => kind === "removed").length,
      changed: changes.filter(({ kind }) => kind === "changed").length,
    },
  };
}
