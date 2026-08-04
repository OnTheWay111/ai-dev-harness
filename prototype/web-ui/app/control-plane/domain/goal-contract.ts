import type { GoalStatus } from "./state-machines.ts";

export interface GoalContractDraft {
  title: string;
  problemStatement: string;
  desiredOutcome: string;
  acceptanceCriteria: readonly string[];
  nonGoals: readonly string[];
  constraints: readonly string[];
}

export interface GoalAcceptanceCriterion {
  id: string;
  position: number;
  statement: string;
  version: number;
}

export interface GoalContract {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  problemStatement: string;
  desiredOutcome: string;
  acceptanceCriteria: readonly GoalAcceptanceCriterion[];
  nonGoals: readonly string[];
  constraints: readonly string[];
  status: GoalStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}
