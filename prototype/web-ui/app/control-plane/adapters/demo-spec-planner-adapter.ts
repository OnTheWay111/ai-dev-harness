import type { SpecBundle } from "../domain/spec-artifact.ts";
import type {
  PlannerDraft,
  PlannerPort,
  PlannerRequest,
} from "../ports/planner-port.ts";

export class DemoSpecPlannerAdapter implements PlannerPort {
  async plan<T = unknown>(request: PlannerRequest): Promise<PlannerDraft<T>> {
    const goal = request.goal;
    const requirements = goal.acceptanceCriteria.map((criterion, index) => ({
      id: `REQ-${index + 1}`,
      statement: criterion.statement,
      acceptanceCriterionRefs: [criterion.id],
    }));
    const output: SpecBundle = {
      schemaVersion: "spec-bundle.v1",
      proposal: {
        summary: `Deliver ${goal.title} through an explicitly reviewed specification.`,
        value: goal.desiredOutcome,
        inScope: requirements.map(({ statement }) => statement),
        outOfScope: [...goal.nonGoals],
        deliverySlices: requirements.map(({ id, statement }) => `${id}: ${statement}`),
      },
      prd: {
        problem: goal.problemStatement,
        users: ["Internal delivery team", "Approver"],
        requirements,
        nonGoals: [...goal.nonGoals],
        constraints: [...goal.constraints],
      },
      architecture: {
        summary: "Deliver the smallest set of components traceable to approved acceptance criteria.",
        components: requirements.map(({ id }, index) => ({
          id: `component-${index + 1}`,
          name: `Delivery component ${index + 1}`,
          responsibility: `Implement and verify ${id}.`,
          requirementRefs: [id],
        })),
        decisions: ["Keep generated content immutable and require a human approval gate."],
      },
      migration: {
        required: false,
        steps: [],
        verification: [],
      },
      rollback: {
        triggers: ["The approved acceptance criteria cannot be verified"],
        steps: ["Stop compilation and supersede the draft with a reviewed revision"],
        dataRecovery: "Retain all prior immutable revisions and restore the last approved revision.",
      },
      solutionElements: requirements.map((requirement, index) => ({
        id: `EL-${index + 1}`,
        title: requirement.statement,
        kind: "product" as const,
        description: `Implementation element for ${requirement.id}.`,
        acceptanceCriterionRefs: [...requirement.acceptanceCriterionRefs],
        constraintRefs: [],
        estimatedCost: "medium" as const,
        removalImpact: `Acceptance criterion ${requirement.acceptanceCriterionRefs[0]} would not be met.`,
        evidence: [requirement.id],
      })),
    };
    return {
      status: "draft",
      plannerRunId: crypto.randomUUID(),
      goalId: goal.id,
      sourceGoalVersion: goal.version,
      output: output as T,
    };
  }
}
