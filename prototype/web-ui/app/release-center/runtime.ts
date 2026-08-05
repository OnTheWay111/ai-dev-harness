import { PostgresRoleBindingRepository } from
  "../auth/postgres-role-binding-repository.ts";
import { readRequestPrincipal } from "../auth/oidc-http.ts";
import { getOidcService } from "../auth/oidc-runtime.ts";
import {
  getGoalWorkspacePool,
  usesDemoGoalWorkspace,
} from "../control-plane/runtime/goal-workspace-runtime.ts";
import { configuredWriteOrigins } from "../security/request-security.ts";
import { RoleBindingReleaseCenterAuthorizer } from "./authorizer.ts";
import { createReleaseCenterHandlers } from "./http.ts";
import { MemoryReleaseCenterRepository } from "./memory-repository.ts";
import { PostgresReleaseCenterRepository } from "./postgres-repository.ts";
import type {
  ReleaseCenterAuthorizer,
  ReleaseCenterRepository,
} from "./repository.ts";
import { ReleaseCenterService } from "./service.ts";

let repository: ReleaseCenterRepository | undefined;
let authorizer: ReleaseCenterAuthorizer | undefined;
let service: ReleaseCenterService | undefined;
let handlers: ReturnType<typeof createReleaseCenterHandlers> | undefined;

export function getReleaseCenterRepository(): ReleaseCenterRepository {
  repository ??= usesDemoGoalWorkspace()
    ? new MemoryReleaseCenterRepository()
    : new PostgresReleaseCenterRepository(getGoalWorkspacePool());
  return repository;
}

export function getReleaseCenterAuthorizer(): ReleaseCenterAuthorizer {
  if (authorizer) return authorizer;
  authorizer = usesDemoGoalWorkspace()
    ? {
        async authorizePermission() {},
        async authorizeRole() {},
      }
    : new RoleBindingReleaseCenterAuthorizer(
        new PostgresRoleBindingRepository(getGoalWorkspacePool()),
      );
  return authorizer;
}

export function getReleaseCenterService(): ReleaseCenterService {
  service ??= new ReleaseCenterService({
    repository: getReleaseCenterRepository(),
    authorizer: getReleaseCenterAuthorizer(),
  });
  return service;
}

export function getReleaseCenterHandlers() {
  handlers ??= createReleaseCenterHandlers({
    service: getReleaseCenterService(),
    allowedOrigins: configuredWriteOrigins(),
    actorResolver: async (request) => {
      const principal = await readRequestPrincipal(request, getOidcService());
      return principal ? { actorId: principal.actorId } : null;
    },
  });
  return handlers;
}
