import type { ClassificationOutput } from "./deterministic-classification.ts";
import type { ClarificationScope } from "./clarification-history.ts";

export interface ClassificationPolicyRevision {
  id: string;
  policyKey: string;
  revision: number;
  schemaVersion: string;
  digest: string;
  definition: Readonly<Record<string, unknown>>;
  actorId: string;
  reason: string;
  createdAt: string;
}

export interface GoalClassification extends ClarificationScope,
  ClassificationOutput {
  id: string;
  revision: number;
  previousClassificationId: string | null;
  sourceGoalVersion: number;
  policyRevisionId: string;
  actorId: string;
  reason: string;
  createdAt: string;
}

export interface ClassificationTimeline {
  policies: ClassificationPolicyRevision[];
  classifications: GoalClassification[];
}

export interface ClassificationReceipt {
  policy: ClassificationPolicyRevision;
  classification: GoalClassification;
}

export class ClassificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassificationValidationError";
  }
}
