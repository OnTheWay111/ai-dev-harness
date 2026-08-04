import type { GoalContract } from "../domain/goal-contract.ts";
import {
  plannerClarificationOutputSchema,
  validatePlannerClarificationOutput,
  type PlannerClarificationOutput,
} from "../domain/planner-clarification-schema.ts";
import type { PlannerDraft, PlannerPort } from "../ports/planner-port.ts";

export class ClarificationPlannerService {
  private readonly planner: PlannerPort;

  constructor(planner: PlannerPort) {
    this.planner = planner;
  }

  async generate(
    goal: GoalContract,
  ): Promise<PlannerDraft<PlannerClarificationOutput>> {
    const draft = await this.planner.plan({
      goal,
      outputSchema: plannerClarificationOutputSchema,
    });
    return {
      ...draft,
      output: validatePlannerClarificationOutput(draft.output),
    };
  }
}
