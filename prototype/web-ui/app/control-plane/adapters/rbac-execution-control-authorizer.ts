import { AuthorizationDeniedError, PolicyEvaluator } from "../../auth/rbac-policy.ts";
import type { RoleBindingReader } from "../../auth/role-binding-repository.ts";
import type { ExecutionControlAuthorizer } from
  "../application/execution-control-service.ts";

export class RbacExecutionControlAuthorizer implements ExecutionControlAuthorizer {
  private readonly roles: RoleBindingReader;
  private readonly policy: PolicyEvaluator;
  private readonly projectOrganization: (projectId: string) => Promise<string | null>;
  private readonly globalOperatorIds: ReadonlySet<string>;

  constructor(input: {
    roles: RoleBindingReader;
    projectOrganization: (projectId: string) => Promise<string | null>;
    globalOperatorIds?: ReadonlySet<string>;
  }) {
    this.roles = input.roles;
    this.policy = new PolicyEvaluator(input.roles);
    this.projectOrganization = input.projectOrganization;
    this.globalOperatorIds = input.globalOperatorIds ?? new Set();
  }

  async authorize(command: Readonly<{
    actorId: string;
    scopeType: "global" | "project";
    scopeId: string;
  }>): Promise<void> {
    if (command.scopeType === "global") {
      if (!this.globalOperatorIds.has(command.actorId)) {
        throw new AuthorizationDeniedError();
      }
      const bindings = await this.roles.listActorActive(command.actorId);
      if (!bindings.some((binding) => binding.role === "organization_owner")) {
        throw new AuthorizationDeniedError();
      }
      return;
    }
    const organizationId = await this.projectOrganization(command.scopeId);
    if (!organizationId) throw new AuthorizationDeniedError();
    await this.policy.assertAllowed({
      actorId: command.actorId,
      organizationId,
      projectId: command.scopeId,
      permission: "run.operate",
    });
  }
}
