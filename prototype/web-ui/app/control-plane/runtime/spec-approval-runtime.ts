import { PostgresRoleBindingRepository } from "../../auth/postgres-role-binding-repository.ts";
import { PolicyEvaluator } from "../../auth/rbac-policy.ts";
import { MemorySpecRevisionRepository } from
  "../adapters/memory-spec-revision-repository.ts";
import { PostgresSpecApprovalRepository } from
  "../adapters/postgres-spec-approval-repository.ts";
import {
  SpecApprovalService,
  type SpecApprovalAuthorizer,
} from "../application/spec-approval-service.ts";
import type { SpecApprovalRepository } from
  "../ports/spec-approval-repository.ts";
import {
  getGoalWorkspacePool,
  usesDemoGoalWorkspace,
} from "./goal-workspace-runtime.ts";
import { getSpecRevisionRepository } from "./spec-generation-runtime.ts";

let service: SpecApprovalService | undefined;

function getRepository(): SpecApprovalRepository {
  if (usesDemoGoalWorkspace()) {
    const repository = getSpecRevisionRepository();
    if (!(repository instanceof MemorySpecRevisionRepository)) {
      throw new Error("Demo SpecRevision repository is unavailable");
    }
    return repository;
  }
  return new PostgresSpecApprovalRepository(getGoalWorkspacePool());
}

function getAuthorizer(): SpecApprovalAuthorizer {
  if (usesDemoGoalWorkspace()) return { async authorize() {} };
  const policy = new PolicyEvaluator(
    new PostgresRoleBindingRepository(getGoalWorkspacePool()),
  );
  return { async authorize(input) { await policy.assertAllowed(input); } };
}

export function getSpecApprovalService(): SpecApprovalService {
  if (!service) {
    service = new SpecApprovalService({
      repository: getRepository(),
      authorizer: getAuthorizer(),
    });
  }
  return service;
}
