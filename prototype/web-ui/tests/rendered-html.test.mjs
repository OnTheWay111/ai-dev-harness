import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  process.env.OIDC_ISSUER = "https://idp.example.invalid";
  process.env.OIDC_CLIENT_ID = "rendered-html-test";
  process.env.OIDC_REDIRECT_URI = "http://localhost/auth/callback";
  process.env.OIDC_COOKIE_SECRET = Buffer.alloc(32, 7).toString("base64url");
  process.env.OIDC_ALLOWED_RETURN_TO_PATHS = "/";
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("protects the server-rendered control plane without a Session", async () => {
  const response = await render();
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "http://localhost/auth/login?returnTo=/",
  );
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(await response.text(), "");
});

test("does not expose workbench content in the unauthenticated response", async () => {
  const response = await render();
  const body = await response.text();
  assert.doesNotMatch(body, /全局任务|执行中心|目标验收|GOAL-/);
});
