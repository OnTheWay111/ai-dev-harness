import {
  AuthorizationDeniedError,
  PolicyEvaluator,
} from "../auth/rbac-policy.ts";
import type {
  Role,
  RoleBindingReader,
} from "../auth/role-binding-repository.ts";
import type {
  ReleaseCenterAuthorizer,
} from "./repository.ts";
import type { ReleaseSignatureRole } from "./domain.ts";

const releaseRoleBindings: Readonly<Record<ReleaseSignatureRole, Role>> = {
  security: "organization_owner",
  operations: "operator",
  product: "approver",
  "project-owner": "project_admin",
};

export class RoleBindingReleaseCenterAuthorizer
implements ReleaseCenterAuthorizer {
  private readonly policy: PolicyEvaluator;
  private readonly bindings: RoleBindingReader;

  constructor(bindings: RoleBindingReader) {
    this.bindings = bindings;
    this.policy = new PolicyEvaluator(bindings);
  }

  async authorizePermission(input: Parameters<
    ReleaseCenterAuthorizer["authorizePermission"]
  >[0]): Promise<void> {
    await this.policy.assertAllowed(input);
  }

  async authorizeRole(input: Parameters<
    ReleaseCenterAuthorizer["authorizeRole"]
  >[0]): Promise<void> {
    const expected = releaseRoleBindings[input.releaseRole];
    const bindings = await this.bindings.listActive(input);
    const allowed = bindings.some((binding) =>
      binding.role === expected &&
      (expected === "organization_owner"
        ? binding.projectId === null
        : binding.projectId === input.projectId)
    );
    if (!allowed) throw new AuthorizationDeniedError();
  }
}
