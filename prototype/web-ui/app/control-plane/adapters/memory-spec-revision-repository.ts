import { VersionConflictError } from "../domain/errors.ts";
import type { SpecRevision } from "../domain/spec-artifact.ts";
import type {
  SpecRevisionRepository,
  SpecRevisionScope,
} from "../ports/spec-revision-repository.ts";

function scopeKey(scope: SpecRevisionScope): string {
  return `${scope.organizationId}/${scope.projectId}/${scope.goalId}`;
}

export class MemorySpecRevisionRepository implements SpecRevisionRepository {
  private readonly revisions = new Map<string, SpecRevision[]>();

  async list(scope: SpecRevisionScope) {
    return { revisions: structuredClone(this.revisions.get(scopeKey(scope)) ?? []) };
  }

  async append(input: Parameters<SpecRevisionRepository["append"]>[0]) {
    const key = scopeKey(input.revision);
    const existing = this.revisions.get(key) ?? [];
    const latest = existing.at(-1) ?? null;
    if (
      (latest?.id ?? null) !== input.expectedPreviousRevisionId ||
      input.revision.revision !== existing.length + 1 ||
      input.revision.sourceGoalVersion !== input.expectedGoalVersion
    ) throw new VersionConflictError();
    const next = structuredClone(input.revision);
    this.revisions.set(key, [...existing, next]);
    return structuredClone(next);
  }
}
