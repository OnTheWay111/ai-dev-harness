import type {
  EstimatedCost,
  SpecSolutionElement,
} from "./spec-artifact.ts";

export const overdesignReviewSchemaVersion = "overdesign-review.v1" as const;
export const overdesignPolicyRevision = "overdesign-policy.v1" as const;

export const overdesignCategories = [
  "Required",
  "Helpful",
  "Speculative",
] as const;
export type OverdesignCategory = (typeof overdesignCategories)[number];

export interface OverdesignReviewItem {
  elementId: string;
  title: string;
  category: OverdesignCategory;
  requirementRefs: readonly string[];
  constraintRefs: readonly string[];
  estimatedCost: EstimatedCost;
  removalImpact: string;
  evidence: readonly string[];
  rationale: string;
}

export interface OverdesignReview {
  schemaVersion: typeof overdesignReviewSchemaVersion;
  policyRevision: typeof overdesignPolicyRevision;
  counts: Readonly<Record<OverdesignCategory, number>>;
  items: readonly OverdesignReviewItem[];
}

export interface OverdesignGoalFacts {
  acceptanceCriterionIds: readonly string[];
  constraints: readonly string[];
}

function intersection(
  references: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  return [...new Set(references.filter((reference) => known.has(reference)))];
}

export function classifySolutionElements(
  goal: OverdesignGoalFacts,
  elements: readonly SpecSolutionElement[],
): OverdesignReview {
  const criteria = new Set(goal.acceptanceCriterionIds);
  const constraints = new Set(goal.constraints);
  const items = elements.map((element): OverdesignReviewItem => {
    const requirementRefs = intersection(element.acceptanceCriterionRefs, criteria);
    const constraintRefs = intersection(element.constraintRefs, constraints);
    let category: OverdesignCategory;
    let rationale: string;
    if (requirementRefs.length > 0) {
      category = "Required";
      rationale = `Directly traces to ${requirementRefs.length} approved acceptance criterion${requirementRefs.length === 1 ? "" : "s"}.`;
    } else if (constraintRefs.length > 0 && element.evidence.length > 0) {
      category = "Helpful";
      rationale = `Supports ${constraintRefs.length} declared constraint${constraintRefs.length === 1 ? "" : "s"} with explicit evidence, but is not required by an acceptance criterion.`;
    } else {
      category = "Speculative";
      rationale = "Has no valid acceptance-criterion trace and no evidenced constraint justification; remove by default.";
    }
    return {
      elementId: element.id,
      title: element.title,
      category,
      requirementRefs,
      constraintRefs,
      estimatedCost: element.estimatedCost,
      removalImpact: element.removalImpact,
      evidence: [...element.evidence],
      rationale,
    };
  });
  return {
    schemaVersion: overdesignReviewSchemaVersion,
    policyRevision: overdesignPolicyRevision,
    counts: {
      Required: items.filter(({ category }) => category === "Required").length,
      Helpful: items.filter(({ category }) => category === "Helpful").length,
      Speculative: items.filter(({ category }) => category === "Speculative").length,
    },
    items,
  };
}
