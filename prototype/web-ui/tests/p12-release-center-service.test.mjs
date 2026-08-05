import assert from "node:assert/strict";
import test from "node:test";

import { MemoryReleaseCenterRepository } from
  "../app/release-center/memory-repository.ts";
import { ReleaseCenterService } from "../app/release-center/service.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
};
const goalId = "00000000-0000-4000-8000-000000000003";
const START = new Date("2026-08-05T00:00:00.000Z");

function command(actorId, key) {
  return {
    actorId,
    requestId: `request-${key}`,
    idempotencyKey: `idempotency-${key}`,
    reason: `Authorized release center command for ${key}`,
  };
}

function fixture() {
  const repository = new MemoryReleaseCenterRepository();
  const authorization = [];
  let sequence = 0;
  const service = new ReleaseCenterService({
    repository,
    authorizer: {
      async authorizePermission(input) { authorization.push(input); },
      async authorizeRole(input) { authorization.push(input); },
    },
    clock: () => START,
    idGenerator: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  return { repository, service, authorization };
}

test("service creates idempotent drafts and requires project-owner approval", async () => {
  const { service, authorization } = fixture();
  const input = {
    ...scope,
    goalId,
    candidateCommit: "a".repeat(40),
    goalContractVersion: 2,
    allowedAreas: ["documentation"],
    excludedAreas: ["production-data"],
    successConditions: ["Goal Verification passed"],
    stopConditions: ["Any P0/P1"],
    rollbackRunbook: "docs/runbooks/deployment-rollback-upgrade.md",
    stopRunbook: "docs/runbooks/execution-stop-worker-loss.md",
    ...command("oidc_operator", "create"),
  };
  const first = await service.createCanary(input);
  const replay = await service.createCanary(input);
  assert.deepEqual(replay, first);
  assert.equal((await service.snapshot({ ...scope, actorId: "oidc_operator" })).canaries.length, 1);

  const approved = await service.approveCanary({
    ...scope,
    canaryId: first.id,
    expectedVersion: first.version,
    ...command("oidc_project_owner", "approve"),
  });
  assert.equal(approved.status, "observing");
  assert.ok(authorization.some((entry) =>
    entry.releaseRole === "project-owner" && entry.actorId === "oidc_project_owner"
  ));
});

test("service derives signer identity and audit receipt instead of trusting clients", async () => {
  const { repository, service, authorization } = fixture();
  repository.seedApprovedRelease({
    id: "00000000-0000-4000-8000-000000000099",
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    goalId,
    status: "awaiting_signatures",
    version: 12,
    evaluatedAt: START.toISOString(),
    attestationDigest: "b".repeat(64),
  });
  const signed = await service.signProductionRelease({
    ...scope,
    releaseId: "00000000-0000-4000-8000-000000000099",
    expectedVersion: 12,
    role: "security",
    ...command("oidc_real_security", "sign-security"),
  });
  assert.equal(signed.signatures[0].signerId, "oidc_real_security");
  assert.match(signed.signatures[0].auditReceiptId, /^[0-9a-f-]{36}$/);
  assert.ok(authorization.some((entry) =>
    entry.releaseRole === "security" && entry.actorId === "oidc_real_security"
  ));
});
