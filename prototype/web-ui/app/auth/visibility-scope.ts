import type {
  RoleBinding,
  RoleBindingReader,
} from "./role-binding-repository.ts";

/**
 * A server-derived authorization boundary. HTTP query parameters must never be
 * used to construct this value.
 */
export interface ActorVisibilityScope {
  actorId: string;
  organizationIds: readonly string[];
  projectIds: readonly string[];
}

export interface ActorVisibilityResolver {
  resolve(actorId: string): Promise<ActorVisibilityScope>;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function visibilityFromRoleBindings(
  actorId: string,
  bindings: readonly RoleBinding[],
): ActorVisibilityScope {
  if (!actorId) throw new Error("actorId is required to resolve visibility");
  const actorBindings = bindings.filter((binding) =>
    binding.actorId === actorId && binding.revokedAt === null
  );
  return {
    actorId,
    organizationIds: uniqueSorted(
      actorBindings
        .filter((binding) =>
          binding.role === "organization_owner" && binding.projectId === null
        )
        .map((binding) => binding.organizationId),
    ),
    projectIds: uniqueSorted(
      actorBindings
        .filter((binding) => binding.projectId !== null)
        .map((binding) => binding.projectId as string),
    ),
  };
}

export class RoleBindingVisibilityResolver
  implements ActorVisibilityResolver
{
  private readonly roles: RoleBindingReader;

  constructor(roles: RoleBindingReader) {
    this.roles = roles;
  }

  async resolve(actorId: string): Promise<ActorVisibilityScope> {
    return visibilityFromRoleBindings(
      actorId,
      await this.roles.listActorActive(actorId),
    );
  }
}

export function hasVisibleProjects(scope: ActorVisibilityScope): boolean {
  return scope.organizationIds.length > 0 || scope.projectIds.length > 0;
}

export function visibilityScopeKey(scope: ActorVisibilityScope): string {
  const canonical = JSON.stringify([
    scope.actorId,
    uniqueSorted(scope.organizationIds),
    uniqueSorted(scope.projectIds),
  ]);
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

