import { expect, test } from "@playwright/test";

import { OidcService } from "../../app/auth/oidc-service";

const baseURL = "https://localhost:4174";
const issuer = "https://p5-e2e-issuer.invalid";
const clientId = "p5-browser-client";
const cookieSecret = Buffer.alloc(32, 7).toString("base64url");
const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";

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
  Object.assign(publicJwk, { kid: "p5-e2e", alg: "RS256", use: "sig" });
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
      const header = encoded({ alg: "RS256", kid: "p5-e2e", typ: "JWT" });
      const payload = encoded({
        iss: issuer,
        sub: "p5-browser-approver",
        aud: clientId,
        nonce,
        iat: nowSeconds,
        exp: nowSeconds + 3_600,
        email: "approver@example.invalid",
        name: "P5 Browser Approver",
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
  const completed = await oidc.complete({
    code: "p5-browser-code",
    state: authorization.searchParams.get("state"),
    transactionCookie: started.transactionCookie,
  });
  return completed.sessionCookie;
}

test("creates, revises, compares, and approves a specification without losing drafts", async ({
  context,
  page,
}) => {
  await context.addCookies([{
    name: "__Host-harness_session",
    value: await sessionCookie(),
    url: baseURL,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);
  const session = await context.request.get(`${baseURL}/api/v1/session`, {
    ignoreHTTPSErrors: true,
  });
  expect(session.status(), await session.text()).toBe(200);
  const hydrated = page.waitForResponse((response) =>
    response.url().includes("/api/v1/workbench") && response.status() === 200
  );
  const documentResponse = await page.goto("/");
  expect(documentResponse?.status()).toBe(200);
  await hydrated;
  await page.getByRole("button", { name: "创建新目标" }).click();
  await page.getByLabel("目标标题").fill("P5 browser review contract");
  await page.getByLabel("问题陈述").fill("Reviewers cannot compare immutable planning revisions.");
  await page.getByLabel("期望结果").fill("Only the latest approved revision can compile.");
  await page.getByLabel("验收标准").fill("Revision differences are visible\nStale approvals return a conflict");
  await page.getByLabel("非目标").fill("Issue compilation");
  await page.getByLabel("约束").fill("Preserve human input on failed writes");
  const createResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/goals") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "创建 Goal Contract" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status(), await createResponse.text()).toBe(201);
  await expect(page.getByText("草稿已保存")).toBeVisible();

  await page.getByRole("button", { name: "进入澄清阶段" }).click();
  await expect(page.getByRole("button", { name: "锁定规划合同" })).toBeVisible();
  await page.getByRole("button", { name: "锁定规划合同" }).click();
  await expect(page.getByRole("button", { name: "生成 Proposal / PRD" })).toBeEnabled();
  await page.getByRole("button", { name: "生成 Proposal / PRD" }).click();
  await expect(page.getByRole("heading", { name: "Proposal / PRD 修订对比" })).toBeVisible();

  const reason = page.getByLabel("审批或修改理由");
  await reason.fill("Approve browser revision one");
  await page.getByRole("button", { name: "提交人工评审" }).click();
  await page.getByRole("button", { name: "批准最小合同" }).click();
  await expect(
    page.getByLabel("人工审批与范围决定").getByText("approved · v3"),
  ).toBeVisible();

  const goalId = await page.evaluate(({ organizationId, projectId }) =>
    localStorage.getItem(
      `goal-workspace:draft:${organizationId}:${projectId}:last-goal`,
    ), { organizationId, projectId });
  expect(goalId).toBeTruthy();
  const firstTimeline = await page.evaluate(async ({ organizationId, projectId, goalId }) => {
    const query = new URLSearchParams({ organizationId, projectId });
    return await (await fetch(`/api/v1/goals/${goalId}/specs?${query}`)).json();
  }, { organizationId, projectId, goalId });
  const firstRevision = firstTimeline.data.revisions[0].specRevision;

  await page.getByRole("button", { name: "重新生成新修订" }).click();
  const revisionTabs = page.getByRole("navigation", { name: "规格修订列表" });
  await expect(revisionTabs.getByRole("button", { name: /Revision 2/ })).toBeVisible();
  await expect(page.getByText("新增 0 · 删除 0 · 修改 0")).toBeVisible();
  await revisionTabs.getByRole("button", { name: /Revision 1/ }).click();
  await expect(page.getByText("该修订已有后续版本，仅供查看；服务端会拒绝任何过期审批。")).toBeVisible();

  const staleResponse = await page.evaluate(async ({
    organizationId,
    projectId,
    goalId,
    firstRevision,
  }) => {
    const response = await fetch(
      `/api/v1/goals/${goalId}/specs/${firstRevision.id}/approvals`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "browser-stale-approval",
          "x-request-id": "browser-stale-approval",
        },
        body: JSON.stringify({
          organizationId,
          projectId,
          expectedVersion: firstRevision.version,
          reason: "Attempt an outdated approval",
          policyRevision: firstRevision.overdesignPolicyRevision,
          decision: "approve",
          affectedItemIds: firstRevision.overdesignReview.items.map(
            (item: { elementId: string }) => item.elementId,
          ),
          payload: { helpfulExceptionElementIds: [], scopeChanges: [] },
        }),
      },
    );
    return { status: response.status, body: await response.json() };
  }, { organizationId, projectId, goalId, firstRevision });
  expect(staleResponse.status).toBe(409);
  expect(staleResponse.body.error.code).toBe("version_conflict");

  await revisionTabs.getByRole("button", { name: /Revision 2/ }).click();
  const preservedReason = "Keep this reason through conflict and network failure";
  const preservedScope = "Keep this scope draft through both failures";
  const scopeDraft = page.getByLabel("范围修改内容");
  await reason.fill(preservedReason);
  await scopeDraft.fill(preservedScope);
  const currentApprovalPattern = /\/specs\/[^/]+\/approvals$/;
  await page.route(currentApprovalPattern, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "version_conflict" } }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "提交人工评审" }).click();
  await expect(reason).toHaveValue(preservedReason);
  await expect(scopeDraft).toHaveValue(preservedScope);
  await page.unroute(currentApprovalPattern);

  await page.route(currentApprovalPattern, async (route) => {
    if (route.request().method() === "POST") await route.abort("failed");
    else await route.continue();
  });
  await page.getByRole("button", { name: "提交人工评审" }).click();
  await expect(reason).toHaveValue(preservedReason);
  await expect(scopeDraft).toHaveValue(preservedScope);
  await page.unroute(currentApprovalPattern);

  await page.getByRole("button", { name: "提交人工评审" }).click();
  await page.getByRole("button", { name: "批准最小合同" }).click();
  await expect(
    page.getByLabel("人工审批与范围决定").getByText("approved · v3"),
  ).toBeVisible();
});
