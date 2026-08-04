import type { IssuePlanDraft } from "../domain/issue-plan.ts";
import type {
  PlannerDraft,
  PlannerPort,
  PlannerRequest,
} from "../ports/planner-port.ts";

export class DemoIssuePlannerAdapter implements PlannerPort {
  async plan<T = unknown>(request: PlannerRequest): Promise<PlannerDraft<T>> {
    const specification = request.approvedSpecification;
    if (request.purpose !== "issue_plan" || !specification) {
      throw new Error("The demo Issue planner requires an approved specification");
    }
    const acceptance = new Map(request.goal.acceptanceCriteria.map((criterion) => [
      criterion.id,
      criterion.statement,
    ]));
    const nonGoals = specification.prd.nonGoals.length
      ? [...specification.prd.nonGoals]
      : ["Do not implement work outside the approved specification"];
    const issues = specification.prd.requirements.map((requirement, index) => {
      const key = `DEV-${String(index + 1).padStart(2, "0")}`;
      const expectedFile = `app/delivery/${requirement.id.toLowerCase()}.ts`;
      const verify = "npm test";
      const acceptanceItems = requirement.acceptanceCriterionRefs.map((criterionRef) => ({
        criterionRef,
        statement: acceptance.get(criterionRef) ?? `Prove approved criterion ${criterionRef}`,
      }));
      const context = [
        `Work in the configured project repository. Goal: ${request.goal.desiredOutcome}.`,
        `Implement ${requirement.id}: ${requirement.statement}.`,
        `Acceptance: ${acceptanceItems.map(({ criterionRef, statement }) => `${criterionRef} (${statement})`).join("; ")}.`,
        `Non-goals: ${nonGoals.join("; ")}.`,
        `Expected file: ${expectedFile}.`,
        `Run ${verify}.`,
        "Return completion evidence containing the test result and a concise implementation summary.",
      ].join(" ");
      return {
        key,
        title: requirement.statement.slice(0, 300),
        goal: request.goal.desiredOutcome,
        requirementRefs: [requirement.id],
        acceptance: acceptanceItems,
        nonGoals,
        dependencyCandidates: index === 0 ? [] : [`DEV-${String(index).padStart(2, "0")}`],
        expectedFiles: [expectedFile],
        conflictResources: {
          directories: [],
          publicInterfaces: [],
          databaseObjects: specification.migration.required ? [`migration:${requirement.id}`] : [],
          sharedConfigurations: [],
          landingOrder: specification.migration.required ? [`migration:${index + 1}`] : [],
        },
        developmentPrompt: context,
        verify: [verify],
        completionEvidence: [
          { kind: "test" as const, description: `Passing verification for ${requirement.id}`, required: true },
          { kind: "artifact" as const, description: `Implementation summary for ${key}`, required: true },
        ],
      };
    });
    const output: IssuePlanDraft = {
      schemaVersion: "issue-plan-draft.v1",
      issues,
    };
    return {
      status: "draft",
      plannerRunId: crypto.randomUUID(),
      goalId: request.goal.id,
      sourceGoalVersion: request.goal.version,
      output: output as T,
    };
  }
}
