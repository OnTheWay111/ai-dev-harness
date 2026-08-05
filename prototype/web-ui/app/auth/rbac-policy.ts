import type {
  Role,
  RoleBindingReader,
  RoleScope,
} from "./role-binding-repository.ts";

export const permissions = [
  "organization.manage",
  "project.manage",
  "role_binding.manage",
  "goal.read",
  "goal.write",
  "goal.approve",
  "goal.verify",
  "goal.accept",
  "spec.read",
  "spec.generate",
  "spec.approve",
  "issue.read",
  "issue.generate",
  "issue.edit",
  "issue.approve",
  "issue.project",
  "run.operate",
  "evidence.read",
  "delivery_report.read",
  "delivery_report.generate",
] as const;

export type Permission = (typeof permissions)[number];

const grants: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  organization_owner: new Set(permissions),
  project_admin: new Set([
    "project.manage",
    "role_binding.manage",
    "goal.read",
    "goal.write",
    "goal.verify",
    "spec.read",
    "spec.generate",
    "issue.read",
    "issue.generate",
    "issue.edit",
    "run.operate",
    "evidence.read",
    "delivery_report.read",
    "delivery_report.generate",
  ]),
  approver: new Set([
    "goal.read",
    "goal.write",
    "goal.approve",
    "goal.verify",
    "goal.accept",
    "spec.read",
    "spec.generate",
    "spec.approve",
    "issue.read",
    "issue.generate",
    "issue.edit",
    "issue.approve",
    "issue.project",
    "evidence.read",
    "delivery_report.read",
    "delivery_report.generate",
  ]),
  operator: new Set([
    "goal.read", "goal.verify", "spec.read", "issue.read", "run.operate",
    "evidence.read", "delivery_report.read", "delivery_report.generate",
  ]),
  viewer: new Set([
    "goal.read", "spec.read", "issue.read", "evidence.read",
    "delivery_report.read",
  ]),
};

export class AuthorizationDeniedError extends Error {
  constructor() {
    super("The actor is not authorized for this operation");
    this.name = "AuthorizationDeniedError";
  }
}

export interface AuthorizationDecision {
  allowed: boolean;
  effectiveRoles: readonly Role[];
}

export class PolicyEvaluator {
  private readonly roles: RoleBindingReader;

  constructor(roles: RoleBindingReader) {
    this.roles = roles;
  }

  async decide(input: RoleScope & {
    permission: Permission;
  }): Promise<AuthorizationDecision> {
    const bindings = await this.roles.listActive(input);
    const effectiveRoles = [...new Set(bindings.map((binding) => binding.role))];
    return {
      allowed: effectiveRoles.some((role) => grants[role].has(input.permission)),
      effectiveRoles,
    };
  }

  async assertAllowed(input: RoleScope & { permission: Permission }): Promise<void> {
    if (!(await this.decide(input)).allowed) throw new AuthorizationDeniedError();
  }

  async assertCanAssignRole(input: RoleScope & {
    targetRole: Role;
    targetProjectId: string | null;
  }): Promise<void> {
    const bindings = await this.roles.listActive({
      actorId: input.actorId,
      organizationId: input.organizationId,
      projectId: input.targetProjectId,
    });
    const owner = bindings.some((binding) =>
      binding.role === "organization_owner" && binding.projectId === null
    );
    if (owner) {
      const validScope = input.targetRole === "organization_owner"
        ? input.targetProjectId === null
        : input.targetRole === "project_admin"
        ? input.targetProjectId !== null
        : true;
      if (validScope) return;
    }
    const projectAdmin = input.targetProjectId !== null && bindings.some(
      (binding) =>
        binding.role === "project_admin" &&
        binding.projectId === input.targetProjectId,
    );
    if (
      projectAdmin &&
      ["approver", "operator", "viewer"].includes(input.targetRole)
    ) {
      return;
    }
    throw new AuthorizationDeniedError();
  }
}
