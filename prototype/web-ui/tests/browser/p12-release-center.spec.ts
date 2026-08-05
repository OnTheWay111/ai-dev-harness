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
  await expect(page.getByText("等待负责人批准", { exact: true })).toBeVisible();

  await installP12Session(context, "p12-approver");
  await page.reload();
  await waitForHydration(page);
  const approvalResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/releases/canaries/") &&
    response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "负责人批准并开始计时" }).click();
  expect((await approvalResponse).status()).toBe(200);
  await expect(page.getByText("12 小时时钟开始计时")).toBeVisible();

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
    const startedAt = new Date(endedAt.getTime() - 12 * HOUR);
    await pool.query(
      `UPDATE release_canaries
          SET created_at=$1,approved_at=$1,started_at=$1,updated_at=$2
        WHERE id=$3`,
      [startedAt, endedAt, canaryId],
    );
    for (let index = 0; index < 12; index += 1) {
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
          actorId("p12-approver"),
          endedAt,
        ],
      );
    }
  } finally {
    await pool.end();
  }

  await installP12Session(context, "p12-approver");
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByText("12.00 / 12 小时")).toBeVisible();
  const finalizeResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/releases/canaries/") &&
    response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "完成 Canary 校验" }).click();
  expect((await finalizeResponse).status()).toBe(200);
  await expect(page.getByText("Canary 报告已通过最终校验")).toBeVisible();
  await page.getByRole("button", { name: "创建 Production Release" }).click();
  await expect(page.getByText("Production Release 已创建")).toBeVisible();

  const gateIds = [
    "browser-e2e", "identity-security", "autodev-authorization",
    "model-routing-write", "supply-chain", "git-traceability",
    "recovery-stop", "observability-oncall", "canary-goal-verification",
    "defect-budget",
  ];
  for (const gateId of gateIds) await writeGate(page, gateId, "owner");

  await installP12Session(context, "p12-approver");
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByText("10/10").first()).toBeVisible();
  await page.getByRole("button", { name: "锁定证据并生成摘要" }).click();
  await expect(page.getByText("十项门禁已锁定")).toBeVisible();
  await expect(page.getByText("等待负责人 OIDC 签署", { exact: true })).toBeVisible();

  await installP12Session(context, "p12-product");
  await page.reload();
  await waitForHydration(page);
  await page.getByLabel("签署角色").selectOption("owner");
  await page.getByLabel("审批理由").fill(
    "A non-owner actor must not be able to forge the owner signature.",
  );
  const forbidden = page.waitForResponse((response) =>
    response.url().includes("/api/v1/releases/production/") &&
    response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "以当前 OIDC 身份签署" }).click();
  expect((await forbidden).status()).toBe(403);
  await expect(page.getByRole("alert")).toContainText("forbidden");

  await installP12Session(context, "p12-approver");
  await page.reload();
  await waitForHydration(page);
  await page.getByLabel("签署角色").selectOption("owner");
  await page.getByLabel("审批理由").fill(
    "The owner approved all ten Production V1 evidence gates.",
  );
  const signatureResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/releases/production/") &&
    response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "以当前 OIDC 身份签署" }).click();
  expect((await signatureResponse).status()).toBe(200);
  await expect(page.getByText("Production V1 发布门禁已全部通过")).toBeVisible();
  await expect(page.getByText("10/10 Gate · 1/1 负责人签署")).toBeVisible();

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
      windows: 12,
      release_status: "approved",
      release_result: "approved",
      gates: 10,
      signatures: 1,
      signers: 1,
      signature_audits: 1,
    });
  } finally {
    await proofPool.end();
  }
});
