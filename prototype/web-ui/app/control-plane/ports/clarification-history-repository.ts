import type {
  ClarificationAnswerReceipt,
  ClarificationGenerationReceipt,
  ClarificationQuestionRevision,
  ClarificationRound,
  ClarificationScope,
  ClarificationTimeline,
  HumanDecision,
} from "../domain/clarification-history.ts";
import type { GoalWorkspaceAuthorizer } from "./goal-workspace-repository.ts";

export interface AppendClarificationRound {
  expectedGoalVersion: number;
  expectedPreviousRoundId: string | null;
  round: ClarificationRound;
  questions: ClarificationQuestionRevision[];
}

export interface AppendClarificationAnswer {
  expectedGoalVersion: number;
  expectedQuestionRevision: number;
  expectedQuestionId: string;
  question: ClarificationQuestionRevision;
  decision: HumanDecision;
}

export interface ClarificationHistoryRepository {
  getTimeline(scope: ClarificationScope): Promise<ClarificationTimeline>;
  appendRound(command: AppendClarificationRound): Promise<ClarificationGenerationReceipt>;
  appendAnswer(command: AppendClarificationAnswer): Promise<ClarificationAnswerReceipt>;
}

export type ClarificationAuthorizer = GoalWorkspaceAuthorizer;
