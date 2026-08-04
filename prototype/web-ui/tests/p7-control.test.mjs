import assert from "node:assert/strict";
import test from "node:test";

import { MemoryExecutionControlRepository } from
  "../app/control-plane/adapters/memory-execution-control-repository.ts";
import {
  ExecutionControlService,
  evaluateDispatchDecision,
} from "../app/control-plane/application/execution-control-service.ts";
import { RbacExecutionControlAuthorizer } from
  "../app/control-plane/adapters/rbac-execution-control-authorizer.ts";
import { MemoryRoleBindingRepository } from
  "../app/auth/memory-role-binding-repository.ts";
import { AuthorizationDeniedError } from
  "../app/auth/rbac-policy.ts";

function command(overrides = {}) {
  return {
    operation: "pause",
    scopeType: "project",
    scopeId: "00000000-0000-4000-8000-000000000002",
    actorId: "operator-1",
    requestId: "request-1",
    idempotencyKey: "control-1",
    expectedVersion: 1,
    reason: "Pause new work during maintenance",
    ...overrides,
  };
}

test("P7 operator commands are authorized, audited, versioned, and idempotent", async () => {
  const repository = new MemoryExecutionControlRepository();
  const authorizations = [];
  const service = new ExecutionControlService({
    repository,
    authorizer: { async authorize(value) { authorizations.push(value); } },
    clock: () => new Date("2026-08-04T12:00:00.000Z"),
  });
  const first = await service.execute(command());
  const replay = await service.execute(command({ requestId: "request-retry" }));
  assert.deepEqual(replay, first);
  assert.equal(first.state, "paused");
  assert.equal(first.version, 2);
  assert.equal(repository.auditEvents.length, 1);
  assert.equal(repository.outboxEvents.length, 1);
  assert.equal(authorizations.length, 2);
  await assert.rejects(
    () => service.execute(command({ idempotencyKey: "control-2", expectedVersion: 1 })),
    /version/i,
  );
});

test("P7 stop, circuit, budget, and pause precedence fail closed", () => {
  assert.deepEqual(evaluateDispatchDecision({
    globalState: "stopped", projectState: "active", circuitOpen: false,
    budgetAvailable: true,
  }), { allowed: false, reason: "global_stop" });
  assert.deepEqual(evaluateDispatchDecision({
    globalState: "active", projectState: "stopped", circuitOpen: false,
    budgetAvailable: true,
  }), { allowed: false, reason: "project_stop" });
  assert.equal(evaluateDispatchDecision({
    globalState: "active", projectState: "active", circuitOpen: true,
    budgetAvailable: true,
  }).reason, "circuit_open");
  assert.equal(evaluateDispatchDecision({
    globalState: "active", projectState: "active", circuitOpen: false,
    budgetAvailable: false,
  }).reason, "budget_exhausted");
  assert.equal(evaluateDispatchDecision({
    globalState: "paused", projectState: "active", circuitOpen: false,
    budgetAvailable: true,
  }).reason, "global_paused");
});

test("P7 pause and drain do not kill a verification or landing task", () => {
  for (const phase of ["verify", "landing"]) {
    assert.equal(evaluateDispatchDecision({
      globalState: "paused", projectState: "active", circuitOpen: false,
      budgetAvailable: true, activePhase: phase,
    }).cancelActive, false);
  }
});

test("P7 project controls require run.operate and global controls fail closed", async () => {
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const projectId = "00000000-0000-4000-8000-000000000002";
  const roles = new MemoryRoleBindingRepository([
    {
      id: crypto.randomUUID(), organizationId, projectId,
      actorId: "operator-1", role: "operator", version: 1,
      createdAt: new Date().toISOString(), revokedAt: null,
    },
    {
      id: crypto.randomUUID(), organizationId, projectId: null,
      actorId: "owner-1", role: "organization_owner", version: 1,
      createdAt: new Date().toISOString(), revokedAt: null,
    },
  ]);
  const authorizer = new RbacExecutionControlAuthorizer({
    roles,
    projectOrganization: async (id) => id === projectId ? organizationId : null,
    globalOperatorIds: new Set(["owner-1"]),
  });
  await authorizer.authorize({
    actorId: "operator-1", scopeType: "project", scopeId: projectId,
    operation: "pause",
  });
  await assert.rejects(
    () => authorizer.authorize({
      actorId: "operator-1", scopeType: "global", scopeId: "global",
      operation: "stop",
    }),
    AuthorizationDeniedError,
  );
  await authorizer.authorize({
    actorId: "owner-1", scopeType: "global", scopeId: "global",
    operation: "stop",
  });
});
