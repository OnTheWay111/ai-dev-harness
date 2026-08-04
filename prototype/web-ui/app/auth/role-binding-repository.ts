export const roles = [
  "organization_owner",
  "project_admin",
  "approver",
  "operator",
  "viewer",
] as const;

export type Role = (typeof roles)[number];

export class RoleBindingConflictError extends Error {
  constructor() {
    super("The RoleBinding changed or already exists");
    this.name = "RoleBindingConflictError";
  }
}

export interface RoleBinding {
  id: string;
  organizationId: string;
  projectId: string | null;
  actorId: string;
  role: Role;
  version: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface RoleScope {
  actorId: string;
  organizationId: string;
  projectId?: string | null;
}

export interface RoleChangeAudit {
  id: string;
  organizationId: string;
  projectId: string | null;
  actorId: string;
  action: "role_binding.assigned" | "role_binding.revoked";
  entityId: string;
  entityVersion: number;
  reason: string;
  requestId: string;
  createdAt: string;
}

export interface RoleBindingReader {
  listActive(scope: RoleScope): Promise<readonly RoleBinding[]>;
}

export interface RoleBindingRepository extends RoleBindingReader {
  get(id: string, organizationId: string): Promise<RoleBinding | null>;
  assign(input: Readonly<{
    binding: RoleBinding;
    audit: RoleChangeAudit;
  }>): Promise<RoleBinding>;
  revoke(input: Readonly<{
    binding: RoleBinding;
    revokedAt: string;
    audit: RoleChangeAudit;
  }>): Promise<RoleBinding>;
}
