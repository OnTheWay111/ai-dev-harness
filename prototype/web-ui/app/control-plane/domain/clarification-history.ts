import type {
  PlannerKnownFact,
  PlannerUncertainty,
  PlannerClarificationQuestion,
} from "./planner-clarification-schema.ts";

export interface ClarificationScope {
  organizationId: string;
  projectId: string;
  goalId: string;
}

export interface ClarificationRound extends ClarificationScope {
  id: string;
  roundNumber: number;
  previousRoundId: string | null;
  regeneratedFromRoundId: string | null;
  sourceGoalVersion: number;
  plannerRunId: string;
  knownFacts: PlannerKnownFact[];
  uncertainties: PlannerUncertainty[];
  actorId: string;
  reason: string;
  createdAt: string;
}

export interface ClarificationQuestionRevision extends ClarificationScope {
  id: string;
  plannerQuestionId: string;
  prompt: string;
  rationale: string;
  blockingLevel: PlannerClarificationQuestion["blockingLevel"];
  answerType: PlannerClarificationQuestion["answerType"];
  suggestedOptions: string[];
  roundId: string;
  threadId: string;
  revision: number;
  previousClarificationId: string | null;
  status: "open" | "answered";
  answer: string | null;
  sourceGoalVersion: number;
  actorId: string;
  reason: string;
  createdAt: string;
}

export interface HumanDecision extends ClarificationScope {
  id: string;
  decisionKey: string;
  revision: number;
  previousDecisionId: string | null;
  status: "approved";
  subjectType: "clarification";
  subjectId: string;
  subjectVersion: number;
  outcome: string;
  actorId: string;
  reason: string;
  createdAt: string;
}

export interface ClarificationTimeline {
  rounds: ClarificationRound[];
  questions: ClarificationQuestionRevision[];
  decisions: HumanDecision[];
}

export interface ClarificationGenerationReceipt {
  round: ClarificationRound;
  questions: ClarificationQuestionRevision[];
}

export interface ClarificationAnswerReceipt {
  question: ClarificationQuestionRevision;
  decision: HumanDecision;
}

export class ClarificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClarificationValidationError";
  }
}

export class ClarificationNotFoundError extends Error {
  constructor() {
    super("Clarification was not found in the authorized scope");
    this.name = "ClarificationNotFoundError";
  }
}

export class ClarificationExpiredError extends Error {
  constructor() {
    super("Clarification no longer belongs to the current Goal version or round");
    this.name = "ClarificationExpiredError";
  }
}
