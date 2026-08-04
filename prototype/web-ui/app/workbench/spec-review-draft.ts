import type { ScopeChange } from "../control-plane/domain/spec-approval";

export interface SpecReviewDraft {
  reason: string;
  helpfulExceptionElementIds: readonly string[];
  scopeChange: ScopeChange;
}

/**
 * Captures user-owned input before a request. Callers restore this snapshot for
 * both optimistic conflicts and transport failures; server responses never
 * replace it with inferred values.
 */
export function preserveSpecReviewDraft(draft: SpecReviewDraft): SpecReviewDraft {
  return {
    reason: draft.reason,
    helpfulExceptionElementIds: [...draft.helpfulExceptionElementIds],
    scopeChange: { ...draft.scopeChange },
  };
}
