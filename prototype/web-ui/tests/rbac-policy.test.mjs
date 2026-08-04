import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthorizationDeniedError,
  PolicyEvaluator,
  permissions,
} from "../app/auth/rbac-policy.ts";
import {
  MemoryRoleBindingRepository,
} from "../app/auth/memory-role-binding-repository.ts";
import {
  RoleBindingApplicationService,
} from "../app/auth/role-binding-service.ts";

const organizationId = "00000000-0000-4000-8000-000000000301";
const projectA = "00000000-0000-4000-8000-000000000302";
const projectB = "00000000-0000-4000-8000-000000000303";

const expectedPermissions = {
  organization_owner: permissions,
  project_admin: [
    "project.manage",
    "role_binding.manage",
    "goal.read",
    "goal.write",
    "spec.read",
    "spec.generate",
    "issue.read",
    "issue.generate",
    "issue.edit",
    "run.operate",
    "evidence.read",
  ],
  approver: [
    "goal.read",
    "goal.write",
    "goal.approve",
    "spec.read",
    "spec.generate",
    "spec.approve",
    "issue.read",
    "issue.generate",
    "issue.edit",
    "issue.approve",
    "issue.project",
    "evidence.read",
  ],
  operator: ["goal.read", "spec.read", "issue.read", "run.operate", "evidence.read"],
  viewer: ["goal.read", "spec.read", "issue.read", "evidence.read"],
};

function binding(role, actorId = role, projectId) {
  return {
    id: crypto.randomUUID(),
    organizationId,
    projectId: projectId === undefined
      ? role === "organization_owner" ? null : projectA
      : projectId,
    actorId,
    role,
    version: 1,
    createdAt: "2026-08-04T08:00:00.000Z",
    revokedAt: null,
  };
}

test("enforces the complete role/permission matrix with default deny", async () => {
  const repository = new MemoryRoleBindingRepository(
    Object.keys(expectedPermissions).map((role) => binding(role)),
  );
  const policy = new PolicyEvaluator(repository);
  for (const [role, granted] of Object.entries(expectedPermissions)) {
    for (const permission of permissions) {
      assert.equal(
        (await policy.decide({
          actorId: role,
          organizationId,
          projectId: projectA,
          permission,
        })).allowed,
        granted.includes(permission),
        `${role} ${permission}`,
      );
    }
  }
  assert.equal((await policy.decide({
    actorId: "unbound",
    organizationId,
    projectId: projectA,
    permission: "goal.read",
  })).allowed, false);
});

test("keeps project roles isolated while organization roles inherit downward", async () => {
  const repository = new MemoryRoleBindingRepository([
    binding("viewer", "project-viewer", projectA),
    binding("viewer", "organization-viewer", null),
    binding("organization_owner", "owner", null),
  ]);
  const policy = new PolicyEvaluator(repository);
  assert.equal((await policy.decide({
    actorId: "project-viewer",
    organizationId,
    projectId: projectB,
    permission: "goal.read",
  })).allowed, false);
  assert.equal((await policy.decide({
    actorId: "organization-viewer",
    organizationId,
    projectId: projectB,
    permission: "goal.read",
  })).allowed, true);
  assert.equal((await policy.decide({
    actorId: "owner",
    organizationId,
    projectId: projectB,
    permission: "organization.manage",
  })).allowed, true);
});

test("limits Project Admin delegation and audits each role change", async () => {
  const owner = binding("organization_owner", "owner", null);
  const admin = binding("project_admin", "admin", projectA);
  const repository = new MemoryRoleBindingRepository([owner, admin]);
  const policy = new PolicyEvaluator(repository);
  const ids = [
    "00000000-0000-4000-8000-000000000304",
    "00000000-0000-4000-8000-000000000305",
  ];
  const service = new RoleBindingApplicationService({
    repository,
    policy,
    clock: () => new Date("2026-08-04T09:00:00.000Z"),
    idGenerator: () => ids.shift(),
  });
  const assigned = await service.assign({
    actorId: "admin",
    organizationId,
    projectId: projectA,
    targetActorId: "new-operator",
    role: "operator",
    reason: "Operate project runs",
    requestId: "request-1",
  });
  assert.equal(assigned.role, "operator");
  assert.equal(repository.auditEvents.length, 1);
  assert.deepEqual(repository.auditEvents[0], {
    id: "00000000-0000-4000-8000-000000000305",
    organizationId,
    projectId: projectA,
    actorId: "admin",
    action: "role_binding.assigned",
    entityId: assigned.id,
    entityVersion: 1,
    reason: "Operate project runs",
    requestId: "request-1",
    createdAt: "2026-08-04T09:00:00.000Z",
  });
  await assert.rejects(
    () => service.assign({
      actorId: "admin",
      organizationId,
      projectId: projectA,
      targetActorId: "another-admin",
      role: "project_admin",
      reason: "Escalate",
      requestId: "request-2",
    }),
    (error) => error instanceof AuthorizationDeniedError,
  );
  await assert.rejects(
    () => service.assign({
      actorId: "admin",
      organizationId,
      projectId: projectB,
      targetActorId: "cross-project",
      role: "viewer",
      reason: "Cross project",
      requestId: "request-3",
    }),
    (error) => error instanceof AuthorizationDeniedError,
  );
  assert.equal(repository.auditEvents.length, 1);
});
