import type {
  RoleBinding,
  RoleBindingRepository,
  RoleChangeAudit,
  RoleScope,
} from "./role-binding-repository.ts";
import { RoleBindingConflictError } from "./role-binding-repository.ts";

export class MemoryRoleBindingRepository implements RoleBindingRepository {
  private readonly bindings: RoleBinding[];
  private readonly audits: RoleChangeAudit[] = [];

  constructor(bindings: readonly RoleBinding[] = []) {
    this.bindings = structuredClone([...bindings]);
  }

  get auditEvents(): RoleChangeAudit[] {
    return structuredClone(this.audits);
  }

  get roleBindings(): RoleBinding[] {
    return structuredClone(this.bindings);
  }

  async listActive(scope: RoleScope): Promise<readonly RoleBinding[]> {
    return structuredClone(this.bindings.filter((binding) =>
      binding.actorId === scope.actorId &&
      binding.organizationId === scope.organizationId &&
      binding.revokedAt === null &&
      (binding.projectId === null || binding.projectId === scope.projectId)
    ));
  }

  async listActorActive(actorId: string): Promise<readonly RoleBinding[]> {
    return structuredClone(
      this.bindings.filter((binding) =>
        binding.actorId === actorId && binding.revokedAt === null
      ),
    );
  }

  async get(id: string, organizationId: string): Promise<RoleBinding | null> {
    const binding = this.bindings.find((candidate) =>
      candidate.id === id && candidate.organizationId === organizationId
    );
    return binding ? structuredClone(binding) : null;
  }

  async assign(input: Readonly<{
    binding: RoleBinding;
    audit: RoleChangeAudit;
  }>): Promise<RoleBinding> {
    if (this.bindings.some((binding) =>
      binding.organizationId === input.binding.organizationId &&
      binding.projectId === input.binding.projectId &&
      binding.actorId === input.binding.actorId &&
      binding.role === input.binding.role &&
      binding.revokedAt === null
    )) {
      throw new RoleBindingConflictError();
    }
    this.bindings.push(structuredClone(input.binding));
    this.audits.push(structuredClone(input.audit));
    return structuredClone(input.binding);
  }

  async revoke(input: Readonly<{
    binding: RoleBinding;
    revokedAt: string;
    audit: RoleChangeAudit;
  }>): Promise<RoleBinding> {
    const index = this.bindings.findIndex((binding) =>
      binding.id === input.binding.id &&
      binding.organizationId === input.binding.organizationId &&
      binding.version === input.binding.version &&
      binding.revokedAt === null
    );
    if (index < 0) throw new RoleBindingConflictError();
    const revoked = {
      ...this.bindings[index],
      version: this.bindings[index].version + 1,
      revokedAt: input.revokedAt,
    };
    this.bindings[index] = revoked;
    this.audits.push(structuredClone(input.audit));
    return structuredClone(revoked);
  }
}
