import type { GoalContract } from "../domain/goal-contract.ts";
import type { SpecBundle } from "../domain/spec-artifact.ts";

export interface GoalPlannerContextPacket {
  contractVersion: "goal-context.v1";
  goalId: string;
  goalVersion: number;
  title: string;
  problemStatement: string;
  desiredOutcome: string;
  acceptanceCriteria: readonly string[];
  nonGoals: readonly string[];
  constraints: readonly string[];
}

export function buildPlannerContextPacket(
  goal: GoalContract,
): GoalPlannerContextPacket {
  return {
    contractVersion: "goal-context.v1",
    goalId: goal.id,
    goalVersion: goal.version,
    title: goal.title,
    problemStatement: goal.problemStatement,
    desiredOutcome: goal.desiredOutcome,
    acceptanceCriteria: goal.acceptanceCriteria.map(({ statement }) => statement),
    nonGoals: [...goal.nonGoals],
    constraints: [...goal.constraints],
  };
}

export type PlannerOutputSchema = Readonly<Record<string, unknown>>;

export interface PlannerRequest {
  goal: GoalContract;
  outputSchema: PlannerOutputSchema;
  purpose?: "clarification" | "specification" | "issue_plan";
  approvedSpecification?: SpecBundle;
}

export interface PlannerDraft<T = unknown> {
  status: "draft";
  plannerRunId: string;
  goalId: string;
  sourceGoalVersion: number;
  output: T;
}

export interface PlannerPort {
  plan<T = unknown>(request: PlannerRequest): Promise<PlannerDraft<T>>;
}

export type PlannerErrorCode =
  | "planner_timeout"
  | "planner_failed"
  | "planner_invalid_output"
  | "planner_budget_exceeded";

export class PlannerExecutionError extends Error {
  readonly code: PlannerErrorCode;

  constructor(code: PlannerErrorCode) {
    super(`Planner execution did not produce an accepted draft (${code})`);
    this.name = "PlannerExecutionError";
    this.code = code;
  }
}
