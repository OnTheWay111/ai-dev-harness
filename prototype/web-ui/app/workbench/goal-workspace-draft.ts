import type { GoalContractDraft } from
  "../control-plane/domain/goal-contract";
import type { GoalWorkspaceScope } from "./goal-workspace-api";

export function goalDraftStorageKey(scope: GoalWorkspaceScope): string {
  return `goal-workspace:draft:${scope.organizationId}:${scope.projectId}`;
}

export function serializeGoalDraft(draft: GoalContractDraft): string {
  return JSON.stringify(draft);
}

export function restoreGoalDraft(value: string | null): GoalContractDraft | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.title !== "string" ||
      typeof parsed.problemStatement !== "string" ||
      typeof parsed.desiredOutcome !== "string" ||
      !Array.isArray(parsed.acceptanceCriteria) ||
      !Array.isArray(parsed.nonGoals) ||
      !Array.isArray(parsed.constraints) ||
      ![parsed.acceptanceCriteria, parsed.nonGoals, parsed.constraints]
        .every((items) => items.every((item) => typeof item === "string"))
    ) return null;
    return parsed as unknown as GoalContractDraft;
  } catch {
    return null;
  }
}
