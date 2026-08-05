import type { AcceptanceVerificationEntry } from
  "../domain/acceptance-verification.ts";
import type {
  DeterministicVerificationResult,
  GoalVerifierOutput,
  GoalVerifierRequest,
} from "../domain/goal-verification.ts";

export interface DeterministicVerifierPort {
  run(
    entry: AcceptanceVerificationEntry,
    context: { organizationId: string; projectId: string; goalId: string },
    signal?: AbortSignal,
  ): Promise<Omit<DeterministicVerificationResult, "entryId" | "criterionRef">>;
}

export interface GoalVerifierPort {
  verify(request: GoalVerifierRequest): Promise<unknown | GoalVerifierOutput>;
}

export interface BuilderIdentitySourcePort {
  list(input: {
    organizationId: string;
    projectId: string;
    goalId: string;
    issuePlanId: string;
  }): Promise<readonly string[]>;
}
