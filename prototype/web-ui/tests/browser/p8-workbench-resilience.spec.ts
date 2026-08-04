import { expect, test } from "@playwright/test";

import { OidcService } from "../../app/auth/oidc-service";

const baseURL = "https://localhost:4174";
const issuer = "https://p5-e2e-issuer.invalid";
const clientId = "p5-browser-client";
const cookieSecret = Buffer.alloc(32, 7).toString("base64url");

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function sessionCookie(): Promise<string> {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  Object.assign(publicJwk, { kid: "p8-e2e", alg: "RS256", use: "sig" });
  let nonce = "";
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url === `${issuer}/jwks`) return Response.json({ keys: [publicJwk] });
    if (url === `${issuer}/token`) {
      const header = encoded({ alg: "RS256", kid: "p8-e2e", typ: "JWT" });
      const payload = encoded({
        iss: issuer,
        sub: "p8-browser-approver",
        aud: clientId,
        nonce,
        iat: nowSeconds,
        exp: nowSeconds + 3_600,
        email: "p8-approver@example.invalid",
        name: "P8 Browser Approver",
      });
      const signingInput = `${header}.${payload}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return Response.json({
        id_token: `${signingInput}.${Buffer.from(signature).toString("base64url")}`,
      });
    }
    return new Response(null, { status: 404 });
  };
  const oidc = new OidcService({
    config: {
      issuer,
      clientId,
      redirectUri: `${baseURL}/auth/callback`,
      cookieSecret,
      allowedReturnToPaths: ["/"],
      sessionTtlSeconds: 3_600,
      transactionTtlSeconds: 600,
    },
    fetch: fakeFetch as typeof fetch,
  });
  const started = await oidc.begin("/");
  const authorization = new URL(started.authorizationUrl);
  nonce = authorization.searchParams.get("nonce") ?? "";
  return (await oidc.complete({
    code: "p8-browser-code",
    state: authorization.searchParams.get("state"),
    transactionCookie: started.transactionCookie,
  })).sessionCookie;
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([{
    name: "__Host-harness_session",
    value: await sessionCookie(),
    url: baseURL,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);
});

test("retains SSR data through a database refresh failure and explains the recovery", async ({ page }) => {
  await page.route("**/api/v1/workbench?limit=50", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "internal_error",
          message: "工作台数据库暂时不可用",
          impact: "本次刷新未完成",
          preservedState: "浏览器继续保留上次成功数据",
          nextAction: "稍后重试",
        },
        requestId: "req-p8-browser-db",
      }),
    });
  });
  await page.goto("/");
  await expect(page.getByText("Web 审批工作区")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("服务暂时不可用");
  await expect(page.getByRole("alert")).toContainText("保留上次成功数据");
  await expect(page.getByRole("alert")).toContainText("稍后重试");
});

test("renders a real empty state from the authoritative response", async ({ page }) => {
  await page.route("**/api/v1/workbench?limit=50", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { etag: '"workbench-empty"' },
      body: JSON.stringify({
        data: {
          schemaVersion: "workbench.v1",
          revision: 22,
          generatedAt: "2026-08-05T02:00:00.000Z",
          summary: {
            metrics: [],
            taskCounts: { all: 0, attention: 0, running: 0, review: 0, blocked: 0, waiting: 0 },
          },
          tasks: [],
        },
        page: { nextCursor: null, total: 0 },
        requestId: "req-p8-browser-empty",
      }),
    });
  });
  await page.goto("/");
  await expect(page.getByText("暂无可见任务，真实数据为空")).toBeVisible();
});

test("preserves the reason on a 409 and prevents duplicate submission while pending", async ({ page }) => {
  const hydrated = page.waitForResponse((response) =>
    response.url().includes("/api/v1/workbench") && response.status() === 200
  );
  await page.goto("/");
  await hydrated;
  await page.getByRole("button", { name: "审查证据" }).click();
  const dialog = page.getByRole("dialog", { name: /审查证据/ });
  await expect(dialog).toBeVisible();
  const reason = dialog.getByLabel("操作理由");
  await reason.fill("Keep this human decision through the conflict");
  await page.route(/\/api\/v1\/tasks\/DEV-07\/actions$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "version_conflict",
          message: "任务已由其他审批人更新",
          impact: "本次决定未提交",
          preservedState: "理由草稿仍保留",
          nextAction: "刷新任务详情后重新确认",
        },
        requestId: "req-p8-browser-conflict",
      }),
    });
  });
  const submit = dialog.getByRole("button", { name: "提交异步命令" });
  await submit.click();
  await expect(dialog.getByRole("button", { name: "提交中…" })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("状态冲突");
  await expect(reason).toHaveValue("Keep this human decision through the conflict");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
