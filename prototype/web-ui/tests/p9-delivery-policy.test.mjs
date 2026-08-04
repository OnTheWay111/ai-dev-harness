import assert from "node:assert/strict";
import test from "node:test";

import { DeliveryPolicyService } from
  "../app/control-plane/application/delivery-policy-service.ts";
import {
  MemoryDeliveryPolicyRepository,
} from "../app/control-plane/adapters/memory-delivery-policy-repository.ts";
import { SecretManagerCredentialBroker } from
  "../app/control-plane/ports/credential-broker-port.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  repositoryId: "00000000-0000-4000-8000-000000000003",
};
const credential = {
  id: "00000000-0000-4000-8000-000000000004",
  ...scope,
  provider: "github_app",
  externalReference: "secret-manager://github/installations/42",
  allowedScopes: ["contents:write", "pull_requests:write"],
  active: true,
  version: 1,
};
const policy = {
  id: "00000000-0000-4000-8000-000000000005",
  ...scope,
  mode: "push_and_open_pr",
  baselineBranch: "main",
  branchPrefix: "autodev/",
  protectedBranches: ["main", "release/*"],
  credentialReferenceId: credential.id,
  revision: 3,
};
const target = {
  ...scope,
  baselineBranch: "main",
  baselineSha: "a".repeat(40),
  branch: "autodev/goal-1/issue-1",
  commitSha: "b".repeat(40),
};

test("defaults to push_disabled and authorizes only bounded repository/branch credentials", async () => {
  const defaultService = new DeliveryPolicyService({
    repository: new MemoryDeliveryPolicyRepository(),
  });
  const disabled = await defaultService.authorize(target);
  assert.equal(disabled.policy.mode, "push_disabled");
  assert.equal(disabled.credential, null);

  const service = new DeliveryPolicyService({
    repository: new MemoryDeliveryPolicyRepository({ policies: [policy], credentials: [credential] }),
  });
  const decision = await service.authorize(target);
  assert.equal(decision.policy.mode, "push_and_open_pr");
  assert.deepEqual(decision.requiredScopes, ["contents:write", "pull_requests:write"]);
  assert.equal(decision.credential.externalReference, credential.externalReference);

  assert.equal((await service.authorize({ ...target, repositoryId: crypto.randomUUID() })).policy.mode, "push_disabled");
  await assert.rejects(() => service.authorize({ ...target, branch: "main" }), /protected/i);
  await assert.rejects(() => service.authorize({ ...target, branch: "release/1.0" }), /protected/i);
  await assert.rejects(() => service.authorize({ ...target, branch: "feature/unbounded" }), /prefix/i);
  await assert.rejects(() => service.authorize({ ...target, baselineBranch: "develop" }), /baseline/i);
});

test("rejects over-privileged or cross-repository credential references", async () => {
  const service = new DeliveryPolicyService({
    repository: new MemoryDeliveryPolicyRepository({
      policies: [policy],
      credentials: [{
        ...credential,
        repositoryId: crypto.randomUUID(),
        allowedScopes: ["contents:write", "pull_requests:write", "administration:write"],
      }],
    }),
  });
  await assert.rejects(() => service.authorize(target), /credential/i);
});

test("applies the latest immutable policy revision after a project policy change", async () => {
  const changed = {
    ...policy,
    id: crypto.randomUUID(),
    mode: "push_disabled",
    credentialReferenceId: null,
    revision: policy.revision + 1,
  };
  const service = new DeliveryPolicyService({
    repository: new MemoryDeliveryPolicyRepository({
      policies: [policy, changed],
      credentials: [credential],
    }),
  });
  const decision = await service.authorize(target);
  assert.equal(decision.policy.id, changed.id);
  assert.equal(decision.policy.mode, "push_disabled");
  assert.equal(decision.credential, null);
});

test("rejects expired, malformed, or overlong runtime credential leases", async () => {
  const now = new Date("2026-08-05T06:00:00.000Z");
  for (const expiresAt of [
    "not-a-date",
    "2026-08-05T05:59:59.000Z",
    "2026-08-05T06:10:01.000Z",
  ]) {
    let revoked = false;
    const broker = new SecretManagerCredentialBroker({
      clock: () => now,
      ttlSeconds: 600,
      secretManager: {
        async issueCredential() {
          return {
            token: "synthetic-lease-token",
            expiresAt,
            scopes: ["contents:write", "pull_requests:write"],
            async revoke() { revoked = true; },
          };
        },
      },
    });
    await assert.rejects(
      () => broker.acquire(credential, ["contents:write", "pull_requests:write"]),
      /invalid|over-privileged/i,
    );
    assert.equal(revoked, true);
  }
});
