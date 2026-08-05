import assert from "node:assert/strict";
import test from "node:test";

import {
  OidcAuthenticationError,
  OidcService,
  createCookieSecret,
  loadOidcConfig,
  oidcLoginUrl,
} from "../app/auth/oidc-service.ts";
import {
  handleOidcCallback,
  handleOidcLogin,
  handleOidcLogout,
} from "../app/auth/oidc-http.ts";

const issuer = "https://idp.example.test";
const clientId = "harness-web";
const redirectUri = "https://harness.example.test/auth/callback";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function signJwt(payload, privateKey, kid = "test-key") {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function sha256Base64Url(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )));
}

async function fakeIdentityProvider({ clock, badSignature = false } = {}) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const otherKeyPair = badSignature
    ? await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )
    : keyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const issued = new Map();
  const usedCodes = new Set();

  return {
    issue(code, authorizationUrl) {
      const url = new URL(authorizationUrl);
      issued.set(code, {
        nonce: url.searchParams.get("nonce"),
        challenge: url.searchParams.get("code_challenge"),
      });
    },
    async fetch(url, init = {}) {
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ["RS256"],
        });
      }
      if (url === `${issuer}/jwks`) {
        return Response.json({
          keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }],
        });
      }
      if (url === `${issuer}/token`) {
        const body = new URLSearchParams(String(init.body));
        const code = body.get("code");
        const issuedCode = issued.get(code);
        if (!issuedCode || usedCodes.has(code)) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        assert.equal(body.get("client_id"), clientId);
        assert.equal(body.get("client_secret"), "server-only-secret");
        assert.equal(body.get("redirect_uri"), redirectUri);
        assert.equal(
          await sha256Base64Url(body.get("code_verifier")),
          issuedCode.challenge,
        );
        usedCodes.add(code);
        const now = Math.floor(clock().getTime() / 1000);
        return Response.json({
          access_token: "must-not-be-persisted",
          token_type: "Bearer",
          id_token: await signJwt({
            iss: issuer,
            sub: "user-123",
            aud: clientId,
            nonce: issuedCode.nonce,
            exp: now + 300,
            iat: now,
            email: "developer@example.test",
            name: "Example Developer",
          }, otherKeyPair.privateKey),
        });
      }
      throw new Error(`unexpected fake IdP request: ${url}`);
    },
  };
}

async function setup(overrides = {}) {
  let current = new Date("2026-08-04T08:00:00.000Z");
  const clock = () => current;
  const provider = await fakeIdentityProvider({
    clock,
    badSignature: overrides.badSignature,
  });
  const service = new OidcService({
    config: {
      issuer,
      clientId,
      clientSecret: "server-only-secret",
      redirectUri,
      cookieSecret: await createCookieSecret(),
      allowedReturnToPaths: ["/", "/goals"],
      sessionTtlSeconds: 8 * 60 * 60,
      transactionTtlSeconds: 10 * 60,
    },
    fetch: provider.fetch,
    clock,
  });
  return {
    provider,
    service,
    advance(milliseconds) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

test("completes Authorization Code + PKCE and stores no OIDC token client-side", async () => {
  const { provider, service } = await setup();
  const started = await service.begin("/goals/goal-1?tab=contract");
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorization.searchParams.get("state"));
  assert.ok(authorization.searchParams.get("nonce"));
  provider.issue("code-1", started.authorizationUrl);

  const completed = await service.complete({
    code: "code-1",
    state: authorization.searchParams.get("state"),
    transactionCookie: started.transactionCookie,
  });
  assert.equal(completed.returnTo, "/goals/goal-1?tab=contract");
  assert.doesNotMatch(completed.sessionCookie, /access_token|developer@example|code-1/);
  const principal = await service.readSession(completed.sessionCookie);
  assert.match(principal.actorId, /^oidc_[0-9a-f]{64}$/);
  assert.deepEqual({ ...principal, actorId: "<stable>" }, {
    issuer,
    subject: "user-123",
    actorId: "<stable>",
    email: "developer@example.test",
    displayName: "Example Developer",
    expiresAt: "2026-08-04T16:00:00.000Z",
  });
});

test("fails closed for expired transactions, bad signatures, replay, and returnTo injection", async () => {
  const expired = await setup();
  const expiredStart = await expired.service.begin("https://evil.example/");
  assert.equal(expiredStart.returnTo, "/");
  const expiredUrl = new URL(expiredStart.authorizationUrl);
  expired.provider.issue("expired-code", expiredStart.authorizationUrl);
  expired.advance(11 * 60 * 1000);
  await assert.rejects(
    () => expired.service.complete({
      code: "expired-code",
      state: expiredUrl.searchParams.get("state"),
      transactionCookie: expiredStart.transactionCookie,
    }),
    (error) => error instanceof OidcAuthenticationError && error.code === "expired",
  );

  const invalid = await setup({ badSignature: true });
  const invalidStart = await invalid.service.begin("/");
  const invalidUrl = new URL(invalidStart.authorizationUrl);
  invalid.provider.issue("bad-signature", invalidStart.authorizationUrl);
  await assert.rejects(
    () => invalid.service.complete({
      code: "bad-signature",
      state: invalidUrl.searchParams.get("state"),
      transactionCookie: invalidStart.transactionCookie,
    }),
    (error) => error instanceof OidcAuthenticationError && error.code === "invalid_token",
  );

  const replay = await setup();
  const replayStart = await replay.service.begin("/");
  const replayUrl = new URL(replayStart.authorizationUrl);
  replay.provider.issue("one-time-code", replayStart.authorizationUrl);
  const input = {
    code: "one-time-code",
    state: replayUrl.searchParams.get("state"),
    transactionCookie: replayStart.transactionCookie,
  };
  await replay.service.complete(input);
  await assert.rejects(
    () => replay.service.complete(input),
    (error) => error instanceof OidcAuthenticationError && error.code === "token_exchange_failed",
  );
});

test("HTTP handlers set hardened cookies and clear the session on POST logout", async () => {
  const { provider, service } = await setup();
  const login = await handleOidcLogin(
    new Request("https://harness.example.test/auth/login?returnTo=%2Fgoals%2F1"),
    service,
  );
  assert.equal(login.status, 302);
  assert.match(login.headers.get("set-cookie"), /__Host-harness_oidc_tx=/);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  const authorization = login.headers.get("location");
  const transactionCookie = login.headers.get("set-cookie").match(
    /__Host-harness_oidc_tx=([^;]+)/,
  )[1];
  provider.issue("http-code", authorization);
  const state = new URL(authorization).searchParams.get("state");
  const callback = await handleOidcCallback(new Request(
    `https://harness.example.test/auth/callback?code=http-code&state=${state}`,
    { headers: { cookie: `__Host-harness_oidc_tx=${transactionCookie}` } },
  ), service);
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/goals/1");
  assert.match(callback.headers.get("set-cookie"), /__Host-harness_session=/);

  const getLogout = await handleOidcLogout(
    new Request("https://harness.example.test/auth/logout"),
  );
  assert.equal(getLogout.status, 405);
  const logout = await handleOidcLogout(
    new Request("https://harness.example.test/auth/logout", {
      method: "POST",
      headers: { origin: "https://harness.example.test" },
    }),
  );
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get("set-cookie"), /__Host-harness_session=;.*Max-Age=0/);
});

test("configuration fails closed without server-only cookie key material", () => {
  assert.throws(
    () => loadOidcConfig({
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: clientId,
      OIDC_REDIRECT_URI: redirectUri,
    }),
    (error) =>
      error instanceof OidcAuthenticationError && error.code === "configuration",
  );
});

test("local HTTP login keeps the configured localhost port", () => {
  assert.equal(
    oidcLoginUrl("/releases", {
      OIDC_REDIRECT_URI: "http://localhost:4175/auth/callback",
    }),
    "http://localhost:4175/auth/login?returnTo=/releases",
  );
  assert.equal(
    oidcLoginUrl("/releases", {
      OIDC_REDIRECT_URI: "http://127.0.0.1:4175/auth/callback",
    }),
    "/auth/login?returnTo=/releases",
  );
});
