import { expect, test } from "@playwright/test";

import pg from "pg";

import {
  installP12Session,
  p12BaseURL,
  p12OrganizationId,
  p12ProjectId,
} from "./p12-browser-auth";

const { Pool } = pg;

test("anonymous and role-less sessions fail closed without leaking scope", async ({
  context,
}) => {
  const anonymous = await context.request.get(
    `${p12BaseURL}/api/v1/workbench?limit=50`,
  );
  expect(anonymous.status()).toBe(401);
  const anonymousBody = await anonymous.text();
  expect(anonymousBody).not.toContain(p12OrganizationId);
  expect(anonymousBody).not.toContain(p12ProjectId);

  await installP12Session(context, "p12-roleless-outsider");
  const forbidden = await context.request.get(
    `${p12BaseURL}/api/v1/workbench?limit=50`,
  );
  expect(forbidden.status()).toBe(403);
  const forbiddenBody = await forbidden.text();
  expect(forbiddenBody).not.toContain(p12OrganizationId);
  expect(forbiddenBody).not.toContain(p12ProjectId);
  expect(forbiddenBody).not.toContain("P12 external fake delivery");
});

test("a transient PostgreSQL failure preserves SSR data and a retry recovers", async ({
  context,
  page,
}) => {
  await installP12Session(context);
  await page.route("**/api/v1/workbench/events?afterRevision=*", (route) =>
    route.abort("connectionreset"));
  let injected = false;
  await page.route("**/api/v1/workbench?limit=50", async (route) => {
    if (!injected) {
      injected = true;
      const response = await fetch(process.env.P12_POSTGRES_BRIDGE_URL!, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.P12_POSTGRES_BRIDGE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation: "fail_next_query" }),
      });
      expect(response.status).toBe(200);
    }
    await route.continue();
  });

  await page.goto("/");
  await expect(page.getByText("P12 external fake delivery")).toBeVisible();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("服务暂时不可用");
  await expect(alert).toContainText("保留");
  await expect(page.getByText("P12 external fake delivery")).toBeVisible();

  const recovered = page.waitForResponse((response) =>
    response.url().includes("/api/v1/workbench?limit=50") &&
    response.status() === 200);
  await alert.getByRole("button", { name: "重新刷新" }).click();
  await recovered;
  await expect(alert).toBeHidden();
  await expect(page.getByText("P12 external fake delivery")).toBeVisible();
});

test("SSE reconnects from the last good revision and resolves a revision jump", async ({
  context,
  page,
}) => {
  await installP12Session(context);
  let connections = 0;
  await page.route("**/api/v1/workbench/events?afterRevision=*", async (route) => {
    connections += 1;
    if (connections === 1) {
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  const hydrated = page.waitForResponse((response) =>
    response.url().includes("/api/v1/workbench?limit=50") &&
    response.status() === 200);
  await page.goto("/");
  await hydrated;
  await expect(page.getByText("P12 external fake delivery")).toBeVisible();
  await expect(page.getByText("实时连接已中断，正在重连")).toBeVisible();
  await expect.poll(() => connections, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("实时连接已中断，正在重连")).toBeHidden();

  const pool = new Pool({
    connectionString: process.env.P12_E2E_DATABASE_URL,
    max: 1,
  });
  try {
    const current = await pool.query<{ revision: string }>(
      `SELECT revision FROM workbench_snapshots
        WHERE scope_id='p12_e2e' AND organization_id=$1 AND project_id=$2`,
      [p12OrganizationId, p12ProjectId],
    );
    const advertisedRevision = Number(current.rows[0].revision) + 2;
    const refreshedPromise = page.waitForResponse(async (response) => {
      if (!response.url().includes("/api/v1/workbench?limit=50") ||
        response.status() !== 200) return false;
      const body = await response.json();
      return body.data?.revision >= advertisedRevision;
    });
    await pool.query(
      `UPDATE workbench_snapshots
          SET revision=revision+2,generated_at=now(),updated_at=now()
        WHERE scope_id='p12_e2e' AND organization_id=$1 AND project_id=$2
      RETURNING revision`,
      [p12OrganizationId, p12ProjectId],
    );
    const refreshed = await refreshedPromise;
    expect((await refreshed.json()).data.revision).toBe(advertisedRevision);
  } finally {
    await pool.end();
  }
  await expect(page.getByText("P12 external fake delivery")).toBeVisible();
});
