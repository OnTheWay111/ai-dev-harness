import { PolicyEvaluator } from "./rbac-policy.ts";
import type {
  Role,
  RoleBinding,
  RoleBindingRepository,
  RoleChangeAudit,
} from "./role-binding-repository.ts";

export class RoleBindingValidationError extends Error {
  constructor() {
    super("The RoleBinding command is invalid");
    this.name = "RoleBindingValidationError";
  }
}

interface RoleBindingCommand {
  actorId: string;
  organizationId: string;
  reason: string;
  requestId: string;
}

export class RoleBindingApplicationService {
  private readonly repository: RoleBindingRepository;
  private readonly policy: PolicyEvaluator;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(input: {
    repository: RoleBindingRepository;
    policy: PolicyEvaluator;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.repository = input.repository;
    this.policy = input.policy;
    this.clock = input.clock ?? (() => new Date());
    this.idGenerator = input.idGenerator ?? (() => crypto.randomUUID());
  }

  private validate(command: RoleBindingCommand): void {
    if (
      command.actorId.trim().length < 1 ||
      command.actorId.length > 200 ||
      command.reason.trim().length < 1 ||
      command.reason.length > 4000 ||
      command.requestId.trim().length < 1 ||
      command.requestId.length > 200
    ) {
      throw new RoleBindingValidationError();
    }
  }

  async assign(command: RoleBindingCommand & {
    projectId: string | null;
    targetActorId: string;
    role: Role;
  }): Promise<RoleBinding> {
    this.validate(command);
    if (
      command.targetActorId.trim().length < 1 ||
      command.targetActorId.length > 200
    ) {
      throw new RoleBindingValidationError();
    }
    await this.policy.assertCanAssignRole({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      targetRole: command.role,
      targetProjectId: command.projectId,
    });
    const createdAt = this.clock().toISOString();
    const binding: RoleBinding = {
      id: this.idGenerator(),
      organizationId: command.organizationId,
      projectId: command.projectId,
      actorId: command.targetActorId,
      role: command.role,
      version: 1,
      createdAt,
      revokedAt: null,
    };
    const audit: RoleChangeAudit = {
      id: this.idGenerator(),
      organizationId: command.organizationId,
      projectId: command.projectId,
      actorId: command.actorId,
      action: "role_binding.assigned",
      entityId: binding.id,
      entityVersion: 1,
      reason: command.reason,
      requestId: command.requestId,
      createdAt,
    };
    return this.repository.assign({ binding, audit });
  }

  async revoke(command: RoleBindingCommand & {
    bindingId: string;
  }): Promise<RoleBinding> {
    this.validate(command);
    const binding = await this.repository.get(
      command.bindingId,
      command.organizationId,
    );
    if (!binding || binding.revokedAt) throw new RoleBindingValidationError();
    await this.policy.assertCanAssignRole({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: binding.projectId,
      targetRole: binding.role,
      targetProjectId: binding.projectId,
    });
    const revokedAt = this.clock().toISOString();
    return this.repository.revoke({
      binding,
      revokedAt,
      audit: {
        id: this.idGenerator(),
        organizationId: binding.organizationId,
        projectId: binding.projectId,
        actorId: command.actorId,
        action: "role_binding.revoked",
        entityId: binding.id,
        entityVersion: binding.version + 1,
        reason: command.reason,
        requestId: command.requestId,
        createdAt: revokedAt,
      },
    });
  }
}
