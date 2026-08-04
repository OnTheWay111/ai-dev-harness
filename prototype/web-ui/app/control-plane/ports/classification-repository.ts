import type {
  ClassificationReceipt,
  ClassificationTimeline,
  GoalClassification,
  ClassificationPolicyRevision,
} from "../domain/classification.ts";
import type { ClarificationScope } from "../domain/clarification-history.ts";

export interface ClassificationRepository {
  getTimeline(scope: ClarificationScope): Promise<ClassificationTimeline>;
  append(input: {
    expectedGoalVersion: number;
    expectedPreviousClassificationId: string | null;
    policy: ClassificationPolicyRevision;
    classification: GoalClassification;
  }): Promise<ClassificationReceipt>;
}
