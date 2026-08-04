import assert from "node:assert/strict";
import test from "node:test";

import { createGoalTransitionHandler } from
  "../app/control-plane/http/goal-transition-handler.ts";
import { configuredWriteOrigins, MemoryFixedWindowRateLimiter } from
  "../app/security/request-security.ts";
import { handleOidcLogout } from "../app/auth/oidc-http.ts";

const routeScope = {
  organizationId: "org-1",
  projectId: "project-1",
  goalId: "goal-1",
};

function validBody(overrides = {}) {
  return {
    expectedVersion: 1,
    nextState: "clarifying",
    reason: "Begin clarification",
    guards: {},
    ...overrides,
  };
}

function request(body, overrides = {}) {
  return new Request("https://control.invalid/goals/goal-1/transition", {
    method: "POST",
    headers: {
      origin: "https://control.invalid",
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      ...overrides.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function handler(overrides = {}) {
  return createGoalTransitionHandler({
    service: {
      async transition(command) {
        return { goalId: command.goalId, state: command.nextState, version: 2 };
      },
    },
    actorResolver: async () => ({ actorId: "actor-1" }),
    ...overrides,
  });
}

test("rejects cross-origin write requests before authentication or persistence", async () => {
  let actorCalls = 0;
  const response = await handler({
    actorResolver: async () => {
      actorCalls += 1;
      return { actorId: "actor-1" };
    },
  })(request(validBody(), {
    headers: { origin: "https://attacker.invalid" },
  }), routeScope);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "csrf_rejected");
  assert.equal(actorCalls, 0);

  const missingOrigin = await handler()(
    new Request("https://control.invalid/goals/goal-1/transition", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "missing-origin",
      },
      body: JSON.stringify(validBody()),
    }),
    routeScope,
  );
  const forgedFetchSite = await handler()(
    request(validBody(), {
      headers: { "sec-fetch-site": "cross-site" },
    }),
    routeScope,
  );
  assert.equal(missingOrigin.status, 403);
  assert.equal(forgedFetchSite.status, 403);
});

test("normalizes explicitly trusted proxy origins and rejects unsafe configuration", async () => {
  assert.deepEqual(configuredWriteOrigins({
    HARNESS_ALLOWED_ORIGINS:
      "https://review.example.invalid,http://localhost:4174,https://review.example.invalid",
  }), ["https://review.example.invalid", "http://localhost:4174"]);
  assert.equal(configuredWriteOrigins({}), undefined);
  assert.throws(() => configuredWriteOrigins({
    HARNESS_ALLOWED_ORIGINS: "http://review.example.invalid",
  }), /HTTPS origins/);
  assert.throws(() => configuredWriteOrigins({
    HARNESS_ALLOWED_ORIGINS: "https://review.example.invalid/path",
  }), /HTTPS origins/);
  const proxied = await handler({
    allowedOrigins: ["https://review.example.invalid"],
  })(request(validBody(), {
    headers: { origin: "https://review.example.invalid" },
  }), routeScope);
  assert.equal(proxied.status, 200);
});

test("rejects unknown fields, unknown guards, and oversized bodies", async () => {
  const unknown = await handler()(
    request(validBody({ injected: true })),
    routeScope,
  );
  const unknownGuard = await handler()(
    request(validBody({ guards: { imaginaryGuard: true } })),
    routeScope,
  );
  const oversized = await handler({ maxBodyBytes: 128 })(
    request(validBody({ reason: "x".repeat(256) })),
    routeScope,
  );
  const wrongType = await handler()(
    request(validBody(), { headers: { "content-type": "text/plain" } }),
    routeScope,
  );
  const invalidHeader = await handler()(
    request(validBody(), { headers: { "idempotency-key": "bad key" } }),
    routeScope,
  );

  assert.equal(unknown.status, 400);
  assert.equal(unknownGuard.status, 400);
  assert.equal(oversized.status, 413);
  assert.equal(wrongType.status, 415);
  assert.equal(invalidHeader.status, 400);
  assert.equal((await oversized.json()).error.code, "payload_too_large");
});

test("limits by actor, organization, and endpoint without merging actors", async () => {
  const limiter = new MemoryFixedWindowRateLimiter({ limit: 1, windowMs: 60_000 });
  const first = await handler({ rateLimiter: limiter })(
    request(validBody()),
    routeScope,
  );
  const repeated = await handler({ rateLimiter: limiter })(
    request(validBody()),
    routeScope,
  );
  const otherActor = await handler({
    rateLimiter: limiter,
    actorResolver: async () => ({ actorId: "actor-2" }),
  })(request(validBody()), routeScope);

  assert.equal(first.status, 200);
  assert.equal(repeated.status, 429);
  assert.equal(otherActor.status, 200);
  assert.equal(repeated.headers.get("retry-after"), "60");
});

test("legal responses carry the browser security baseline", async () => {
  const response = await handler()(request(validBody()), routeScope);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("logout is also same-origin and rejects request bodies", async () => {
  const crossOrigin = await handleOidcLogout(
    new Request("https://control.invalid/auth/logout", {
      method: "POST",
      headers: { origin: "https://attacker.invalid" },
    }),
  );
  const body = await handleOidcLogout(
    new Request("https://control.invalid/auth/logout", {
      method: "POST",
      headers: { origin: "https://control.invalid" },
      body: "unexpected",
    }),
  );
  const legal = await handleOidcLogout(
    new Request("https://control.invalid/auth/logout", {
      method: "POST",
      headers: { origin: "https://control.invalid" },
    }),
  );

  assert.equal(crossOrigin.status, 403);
  assert.equal(body.status, 400);
  assert.equal(legal.status, 303);
  assert.match(legal.headers.get("set-cookie") ?? "", /Max-Age=0/);
});
