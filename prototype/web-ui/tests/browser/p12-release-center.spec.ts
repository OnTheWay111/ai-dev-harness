import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";
import pg from "pg";

import {
  installP12Session,
  p12OrganizationId,
  p12ProjectId,
  p12ReleaseGoalId,
} from "./p12-browser-auth";

const { Pool } = pg;
const HOUR = 60 * 60 * 1_000;
const issuer = "https://p12-issuer.example.invalid";

function actorId(subject: string): string {
  return `oidc_${createHash("sha256")
    .update(`${issuer}\0${subject}`)
    .digest("hex")}`;
}

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(page.locator(".release-center-shell")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
}

async function writeGate(
  page: import("@playwright/test").Page,
  gateId: string,
  role: string,
) {
  await page.getByLabel("门禁").selectOption(gateId);
  await page.getByLabel("责任角色").selectOption(role);
  await page.getByLabel("证据引用").fill(`gate-receipt:${gateId}`);
  const response = page.waitForResponse((candidate) =>
    candidate.url().includes("/api/v1/releases/production/") &&
    candidate.request().method() === "POST"
  );
  await page.getByRole("button", { name: "确认门禁通过" }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("button", { name: "确认门禁通过" })).toBeEnabled();
}

test("P12 Release Center persists Canary, gates, OIDC signatures, and audit receipts", async ({
  context,
  page,
}) => {
  await installP12Session(context, "p12-approver");
  await page.goto("/releases");
  await expect(page.getByRole("heading", { name: "P12 发布中心" })).toBeVisible();
  await waitForHydration(page);
  await expect(page.getByRole("button", { name: "创建 Canary 草稿" })).toBeEnabled();
  await page.getByLabel("Goal ID").fill(p12ReleaseGoalId);
  await page.getByLabel("候选 Commit").fill("a".repeat(40));
  const createResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/releases/canaries") &&
    response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "创建 Canary 草稿" }).click();
  const created = await createResponse;
  expect(await created.json()).toMatchObject({ data: { status: "draft" } });
  expect(created.status()).toBe(201);
  await expect(page.getByText("Canary 草稿已创建")).toBeVisible();
  await expect(page.getByText("等待项目负责人批准", { exact: true })).toBeVisible();

  await installP12Session(context, "p12-project-owner");
  await page.reload();
  await waitForHydration(page);
  const approvalResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/releases/canaries/") &&
    response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "项目负责人批准并开始计时" }).click();
  expect((await approvalResponse).status()).toBe(200);
  await expect(page.getByText("48 小时时钟开始计时")).toBeVisible();

  const pool = new Pool({ connectionString: process.env.P12_E2E_DATABASE_URL, max: 2 });
  let canaryId = "";
  try {
    const selected = await pool.query<{ id: string }>(
      `SELECT id FROM release_canaries
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
        ORDER BY created_at DESC LIMIT 1`,
      [p12OrganizationId, p12ProjectId, p12ReleaseGoalId],
    );
    canaryId = selected.rows[0].id;
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - 48 * HOUR);
    await pool.query(
      `UPDATE release_canaries
          SET created_at=$1,approved_at=$1,started_at=$1,updated_at=$2
        WHERE id=$3`,
      [startedAt, endedAt, canaryId],
    );
    for (let index = 0; index < 48; index += 1) {
      await pool.query(
        `INSERT INTO release_canary_windows
           (organization_id,project_id,goal_id,canary_id,attempt,sequence,
            started_at,ended_at,status,p0_count,p1_count,evidence_refs,
            recorded_by,created_at)
         VALUES ($1,$2,$3,$4,1,$5,$6,$7,'healthy',0,0,$8::jsonb,$9,$10)`,
        [
          p12OrganizationId,
          p12ProjectId,
          p12ReleaseGoalId,
          canaryId,
          index + 1,
          new Date(startedAt.getTime() + index * HOUR),
          new Date(startedAt.getTime() + (index + 1) * HOUR),
          JSON.stringify([`metric-window:${index + 1}`]),
          actorId("p12-operations"),
          endedAt,
        ],
      );
    }
  } finally {
    await pool.end();
  }

  await installP12Session(context, "p12-operations");
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByText("48.00 / 48 小时")).toBeVisible();
  const finalizeResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/releases/canaries/") &&
    response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "完成 Canary 校验" }).click();
  expect((await finalizeResponse).status()).toBe(200);
  await expect(page.getByText("Canary 报告已通过最终校验")).toBeVisible();
  await page.getByRole("button", { name: "创建 Production Release" }).click();
  await expect(page.getByText("Production Release 已创建")).toBeVisible();

  const assignments = {
    security: ["browser-e2e", "identity-security", "supply-chain"],
    operations: ["autodev-authorization", "recovery-stop", "observability-oncall"],
    product: ["model-routing-write", "defect-budget"],
    "project-owner": ["git-traceability", "canary-goal-verification"],
  } as const;
  const subjects = {
    security: "p12-approver",
    operations: "p12-operations",
    product: "p12-product",
    "project-owner": "p12-project-owner",
  } as const;
  for (const role of Object.keys(assignments) as Array<keyof typeof assignments>) {
    await installP12Session(context, subjects[role]);
    await page.reload();
    await waitForHydration(page);
    for (const gateId of assignments[role]) await writeGate(page, gateId, role);
  }

  await installP12Session(context, "p12-operations");
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByText("10/10").first()).toBeVisible();
  await page.getByRole("button", { name: "锁定证据并生成摘要" }).click();
  await expect(page.getByText("十项门禁已锁定")).toBeVisible();
  await expect(page.getByText("等待四方 OIDC 签署", { exact: true })).toBeVisible();

  await installP12Session(context, "p12-product");
  await page.reload();
  await waitForHydration(page);
  await page.getByLabel("签署角色").selectOption("security");
  await page.getByLabel("审批理由").fill(
    "Product actor must not be able to forge the security signature.",
  );
  const forbidden = page.waitForResponse((response) =>
    response.url().includes("/api/v1/releases/production/") &&
    response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "以当前 OIDC 身份签署" }).click();
  expect((await forbidden).status()).toBe(403);
  await expect(page.getByRole("alert")).toContainText("forbidden");

  for (const role of Object.keys(subjects) as Array<keyof typeof subjects>) {
    await installP12Session(context, subjects[role]);
    await page.reload();
    await waitForHydration(page);
    await page.getByLabel("签署角色").selectOption(role);
    await page.getByLabel("审批理由").fill(
      `Approved ${role} after reviewing all ten Production V1 evidence gates.`,
    );
    const signatureResponse = page.waitForResponse((response) =>
      response.url().includes("/api/v1/releases/production/") &&
      response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "以当前 OIDC 身份签署" }).click();
    expect((await signatureResponse).status()).toBe(200);
  }
  await expect(page.getByText("Production V1 发布门禁已全部通过")).toBeVisible();
  await expect(page.getByText("10/10 Gate · 4/4 独立签署")).toBeVisible();

  const proofPool = new Pool({
    connectionString: process.env.P12_E2E_DATABASE_URL,
    max: 1,
  });
  try {
    const proof = await proofPool.query(
      `SELECT
        (SELECT status FROM release_canaries WHERE id=$1) AS canary_status,
        (SELECT count(*)::int FROM release_canary_windows WHERE canary_id=$1) AS windows,
        pr.status AS release_status,
        pr.report->>'result' AS release_result,
        (SELECT count(*)::int FROM production_gate_checks WHERE release_id=pr.id) AS gates,
        (SELECT count(*)::int FROM production_release_signatures WHERE release_id=pr.id) AS signatures,
        (SELECT count(DISTINCT signer_id)::int FROM production_release_signatures WHERE release_id=pr.id) AS signers,
        (SELECT count(*)::int FROM production_release_signatures s
           JOIN audit_events a ON a.id=s.audit_receipt_id
          WHERE s.release_id=pr.id AND a.action='release.production.signed') AS signature_audits
       FROM production_releases pr WHERE pr.canary_id=$1`,
      [canaryId],
    );
    expect(proof.rows[0]).toEqual({
      canary_status: "passed",
      windows: 48,
      release_status: "approved",
      release_result: "approved",
      gates: 10,
      signatures: 4,
      signers: 4,
      signature_audits: 4,
    });
  } finally {
    await proofPool.end();
  }
});
