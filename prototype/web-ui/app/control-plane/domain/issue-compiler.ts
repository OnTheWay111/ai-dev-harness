import type { IssueDraft } from "./issue-plan.ts";

export const issueCompilerPolicyRevision = "issue-compiler.v1" as const;

export type IssueCompilationDiagnosticCode =
  | "duplicate_issue_key"
  | "unknown_requirement_ref"
  | "unknown_acceptance_ref"
  | "acceptance_without_requirement"
  | "orphan_issue"
  | "uncovered_requirement"
  | "uncovered_acceptance"
  | "missing_dependency"
  | "self_dependency"
  | "duplicate_dependency"
  | "dependency_cycle";

export interface IssueCompilationDiagnostic {
  code: IssueCompilationDiagnosticCode;
  path: string;
  message: string;
  impact: string;
  relatedIssueKeys: readonly string[];
}

export interface IssueCompilationResult {
  policyRevision: typeof issueCompilerPolicyRevision;
  valid: boolean;
  diagnostics: readonly IssueCompilationDiagnostic[];
  coverage: {
    requirements: { covered: readonly string[]; uncovered: readonly string[] };
    acceptanceCriteria: { covered: readonly string[]; uncovered: readonly string[] };
  };
  topologicalOrder: readonly string[];
}

interface CompileInput {
  requirements: readonly {
    id: string;
    acceptanceCriterionRefs: readonly string[];
  }[];
  acceptanceCriterionIds: readonly string[];
  issues: readonly Pick<IssueDraft,
    "key" | "requirementRefs" | "acceptance" | "dependencyCandidates">[];
}

function diagnostic(
  code: IssueCompilationDiagnosticCode,
  path: string,
  message: string,
  impact: string,
  relatedIssueKeys: readonly string[] = [],
): IssueCompilationDiagnostic {
  return { code, path, message, impact, relatedIssueKeys };
}

function findCycle(keys: readonly string[], dependencies: ReadonlyMap<string, readonly string[]>): string[] {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  let found: string[] = [];
  const visit = (key: string): boolean => {
    state.set(key, "visiting");
    stack.push(key);
    for (const dependency of [...(dependencies.get(key) ?? [])].sort()) {
      if (!dependencies.has(dependency)) continue;
      if (state.get(dependency) === "visiting") {
        const start = stack.indexOf(dependency);
        found = [...stack.slice(start), dependency];
        return true;
      }
      if (!state.has(dependency) && visit(dependency)) return true;
    }
    stack.pop();
    state.set(key, "done");
    return false;
  };
  for (const key of [...keys].sort()) {
    if (!state.has(key) && visit(key)) break;
  }
  return found;
}

function topologicalOrder(
  keys: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): string[] {
  const uniqueKeys = [...new Set(keys)].sort();
  const known = new Set(uniqueKeys);
  const remaining = new Map(uniqueKeys.map((key) => [
    key,
    new Set((dependencies.get(key) ?? []).filter((dependency) => known.has(dependency))),
  ]));
  const result: string[] = [];
  while (remaining.size) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([key]) => key)
      .sort();
    if (ready.length === 0) break;
    for (const key of ready) {
      result.push(key);
      remaining.delete(key);
      for (const deps of remaining.values()) deps.delete(key);
    }
  }
  return result;
}

export function compileIssuePlan(input: CompileInput): IssueCompilationResult {
  const diagnostics: IssueCompilationDiagnostic[] = [];
  const requirementIds = new Set(input.requirements.map(({ id }) => id));
  const acceptanceIds = new Set(input.acceptanceCriterionIds);
  const acceptanceByRequirement = new Map(input.requirements.map((requirement) => [
    requirement.id,
    new Set(requirement.acceptanceCriterionRefs),
  ]));
  const issueKeys = input.issues.map(({ key }) => key);
  const knownIssueKeys = new Set(issueKeys);
  const seenKeys = new Set<string>();
  const coveredRequirements = new Set<string>();
  const coveredAcceptance = new Set<string>();
  const dependencies = new Map<string, readonly string[]>();

  input.issues.forEach((issue, index) => {
    const path = `issues[${index}]`;
    if (seenKeys.has(issue.key)) {
      diagnostics.push(diagnostic(
        "duplicate_issue_key", `${path}.key`, `Issue key ${issue.key} is duplicated`,
        "The dependency graph cannot identify a unique delivery unit", [issue.key],
      ));
    }
    seenKeys.add(issue.key);
    if (issue.requirementRefs.length === 0 && issue.acceptance.length === 0) {
      diagnostics.push(diagnostic(
        "orphan_issue", path, `Issue ${issue.key} has no traceability references`,
        "The Issue cannot be justified by the approved specification", [issue.key],
      ));
    }
    for (const [refIndex, ref] of issue.requirementRefs.entries()) {
      if (!requirementIds.has(ref)) {
        diagnostics.push(diagnostic(
          "unknown_requirement_ref", `${path}.requirementRefs[${refIndex}]`,
          `Requirement ${ref} does not exist`,
          "Approval would claim coverage for an unapproved requirement", [issue.key],
        ));
      } else coveredRequirements.add(ref);
    }
    const permittedAcceptance = new Set(issue.requirementRefs.flatMap((ref) =>
      [...(acceptanceByRequirement.get(ref) ?? [])]
    ));
    issue.acceptance.forEach(({ criterionRef }, acceptanceIndex) => {
      if (!acceptanceIds.has(criterionRef)) {
        diagnostics.push(diagnostic(
          "unknown_acceptance_ref", `${path}.acceptance[${acceptanceIndex}].criterionRef`,
          `Acceptance criterion ${criterionRef} does not exist`,
          "The completion proof would target an unknown criterion", [issue.key],
        ));
      } else {
        coveredAcceptance.add(criterionRef);
        if (!permittedAcceptance.has(criterionRef)) {
          diagnostics.push(diagnostic(
            "acceptance_without_requirement", `${path}.acceptance[${acceptanceIndex}]`,
            `Acceptance criterion ${criterionRef} is not linked by the Issue requirements`,
            "Bidirectional traceability is broken", [issue.key],
          ));
        }
      }
    });
    const seenDependencies = new Set<string>();
    issue.dependencyCandidates.forEach((dependency, dependencyIndex) => {
      const dependencyPath = `${path}.dependencyCandidates[${dependencyIndex}]`;
      if (seenDependencies.has(dependency)) {
        diagnostics.push(diagnostic(
          "duplicate_dependency", dependencyPath,
          `Dependency ${dependency} is repeated`,
          "The graph contains an ambiguous duplicate edge", [issue.key, dependency],
        ));
      }
      seenDependencies.add(dependency);
      if (dependency === issue.key) {
        diagnostics.push(diagnostic(
          "self_dependency", dependencyPath, `Issue ${issue.key} depends on itself`,
          "The Issue can never become dependency-ready", [issue.key],
        ));
      } else if (!knownIssueKeys.has(dependency)) {
        diagnostics.push(diagnostic(
          "missing_dependency", dependencyPath, `Dependency ${dependency} does not exist`,
          "The Issue can never be safely scheduled", [issue.key, dependency],
        ));
      }
    });
    dependencies.set(issue.key, issue.dependencyCandidates);
  });

  const uncoveredRequirements = [...requirementIds]
    .filter((id) => !coveredRequirements.has(id)).sort();
  const uncoveredAcceptance = [...acceptanceIds]
    .filter((id) => !coveredAcceptance.has(id)).sort();
  for (const id of uncoveredRequirements) diagnostics.push(diagnostic(
    "uncovered_requirement", `requirements.${id}`, `Requirement ${id} is not covered`,
    "The approved PRD would not be fully implemented",
  ));
  for (const id of uncoveredAcceptance) diagnostics.push(diagnostic(
    "uncovered_acceptance", `acceptanceCriteria.${id}`,
    `Acceptance criterion ${id} is not covered`,
    "Goal verification would have no implementing Issue",
  ));

  const cycle = findCycle(issueKeys, dependencies);
  if (cycle.length) diagnostics.push(diagnostic(
    "dependency_cycle", "issues[*].dependencyCandidates",
    `Dependency cycle: ${cycle.join(" -> ")}`,
    "No Issue in the cycle can become dependency-ready", cycle,
  ));

  return {
    policyRevision: issueCompilerPolicyRevision,
    valid: diagnostics.length === 0,
    diagnostics,
    coverage: {
      requirements: {
        covered: [...coveredRequirements].filter((id) => requirementIds.has(id)).sort(),
        uncovered: uncoveredRequirements,
      },
      acceptanceCriteria: {
        covered: [...coveredAcceptance].filter((id) => acceptanceIds.has(id)).sort(),
        uncovered: uncoveredAcceptance,
      },
    },
    topologicalOrder: cycle.length ? [] : topologicalOrder(issueKeys, dependencies),
  };
}
