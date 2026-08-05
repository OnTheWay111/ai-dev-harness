import assert from "node:assert/strict";
import test from "node:test";

import { createReleaseCenterHandlers } from
  "../app/release-center/http.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
};
const releaseId = "00000000-0000-4000-8000-000000000003";

function request(path, body, headers = {}) {
  return new Request(`https://harness.example${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? headers : {
      origin: "https://harness.example",
      "content-type": "application/json",
      "idempotency-key": "release-handler-test-key",
      "x-request-id": "release-handler-test-request",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("release handler fails closed for anonymous reads", async () => {
  const handlers = createReleaseCenterHandlers({
    service: { async snapshot() { throw new Error("must not be called"); } },
    actorResolver: async () => null,
    allowedOrigins: ["https://harness.example"],
  });
  const response = await handlers.collection(request(
    `/api/v1/releases?organizationId=${scope.organizationId}&projectId=${scope.projectId}`,
  ));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "authentication_required");
});

test("signature action uses the OIDC actor and rejects client supplied signer fields", async () => {
  let received;
  const handlers = createReleaseCenterHandlers({
    service: {
      async signProductionRelease(input) {
        received = input;
        return { id: releaseId, signatures: [{ signerId: input.actorId }] };
      },
    },
    actorResolver: async () => ({ actorId: "oidc_owner_actor" }),
    allowedOrigins: ["https://harness.example"],
  });
  const invalid = await handlers.productionAction(request(
    `/api/v1/releases/production/${releaseId}/actions`,
    {
      ...scope,
      type: "sign",
      role: "owner",
      signerId: "forged-client-identity",
      expectedVersion: 2,
      reason: "The client must not choose the signer identity.",
    },
  ), releaseId);
  assert.equal(invalid.status, 400);

  const response = await handlers.productionAction(request(
    `/api/v1/releases/production/${releaseId}/actions`,
    {
      ...scope,
      type: "sign",
      role: "owner",
      expectedVersion: 2,
      reason: "The owner reviewed and approved all release evidence.",
    },
  ), releaseId);
  assert.equal(response.status, 200);
  assert.equal(received.actorId, "oidc_owner_actor");
  assert.equal(received.requestId, "release-handler-test-request");
});

test("release writes reject cross-origin requests before service invocation", async () => {
  let called = false;
  const handlers = createReleaseCenterHandlers({
    service: { async createCanary() { called = true; } },
    actorResolver: async () => ({ actorId: "oidc_operator" }),
    allowedOrigins: ["https://harness.example"],
  });
  const response = await handlers.canaryCollection(request(
    "/api/v1/releases/canaries",
    { ...scope },
    { origin: "https://attacker.example" },
  ));
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test("release writes reject server-owned nested evidence fields", async () => {
  let called = false;
  const handlers = createReleaseCenterHandlers({
    service: { async recordCanaryWindow() { called = true; } },
    actorResolver: async () => ({ actorId: "oidc_operator" }),
    allowedOrigins: ["https://harness.example"],
  });
  const response = await handlers.canaryAction(request(
    `/api/v1/releases/canaries/${releaseId}/actions`,
    {
      ...scope,
      type: "record-window",
      expectedVersion: 1,
      reason: "Reject client attempts to forge the evidence recorder identity.",
      window: {
        sequence: 1,
        startedAt: "2026-08-05T00:00:00.000Z",
        endedAt: "2026-08-05T01:00:00.000Z",
        status: "healthy",
        p0Count: 0,
        p1Count: 0,
        evidenceRefs: ["metric-window:1"],
        recordedBy: "forged-client-identity",
      },
    },
  ), releaseId);
  assert.equal(response.status, 400);
  assert.equal(called, false);
});
