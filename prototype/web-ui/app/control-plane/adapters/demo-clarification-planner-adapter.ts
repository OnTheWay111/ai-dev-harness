import type { PlannerClarificationOutput } from "../domain/planner-clarification-schema.ts";
import {
  buildPlannerContextPacket,
  type PlannerDraft,
  type PlannerPort,
  type PlannerRequest,
} from "../ports/planner-port.ts";

/** Local demo only. Managed deployments inject the isolated execution gateway. */
export class DemoClarificationPlannerAdapter implements PlannerPort {
  async plan<T = unknown>(request: PlannerRequest): Promise<PlannerDraft<T>> {
    const goal = buildPlannerContextPacket(request.goal);
    const output: PlannerClarificationOutput = {
      schemaVersion: "planner-clarification.v1",
      knownFacts: [
        { id: "goal_title", fact: `Goal: ${goal.title}`, basis: "goal_contract" },
      ],
      uncertainties: [
        {
          id: "operational_boundary",
          statement: "The operational ownership boundary needs human confirmation.",
          impact: "It changes approval and rollout expectations.",
        },
      ],
      questions: [
        {
          id: "operational_owner",
          prompt: "Who owns the production outcome and rollback decision?",
          rationale: "A named human owner is required before execution planning.",
          blockingLevel: "high",
          answerType: "text",
          suggestedOptions: [],
        },
      ],
    };
    return {
      status: "draft",
      plannerRunId: crypto.randomUUID(),
      goalId: goal.goalId,
      sourceGoalVersion: goal.goalVersion,
      output: output as T,
    };
  }
}
