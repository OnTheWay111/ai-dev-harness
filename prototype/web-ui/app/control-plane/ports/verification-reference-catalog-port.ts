import type { VerificationReferenceCatalog } from
  "../domain/acceptance-verification.ts";
import type { GoalVerificationScope } from
  "./goal-verification-repository.ts";

export interface VerificationReferenceCatalogPort {
  list(scope: GoalVerificationScope): Promise<VerificationReferenceCatalog>;
}
