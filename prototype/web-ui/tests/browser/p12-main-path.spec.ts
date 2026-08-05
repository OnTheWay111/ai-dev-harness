import { expect, test } from "@playwright/test";

import pg from "pg";

import {
  installP12Session,
  p12BaseURL as baseURL,
  p12OrganizationId as organizationId,
  p12ProjectId as projectId,
} from "./p12-browser-auth";

const { Pool } = pg;

async function transitionGoal(
  page: import("@playwright/test").Page,
  goalId: string,
  nextState: "approved" | "executing" | "verifying",
  guard: "specApproved" | "issuesApproved" | "allIssuesCompleted",
): Promise<void> {
  const result = await page.evaluate(async ({
    organizationId,
    projectId,
    goalId,
    nextState,
    guard,
  }) => {
    const query = new URLSearchParams({ organizationId, projectId });
    const currentResponse = await fetch(`/api/v1/goals/${goalId}?${query}`);
    const current = (await currentResponse.json()).data;
    const response = await fetch(`/api/v1/goals/${goalId}/transitions?${query}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `p12-${nextState}`,
        "x-request-id": `p12-${nextState}`,
      },
      body: JSON.stringify({
        expectedVersion: current.version,
        nextState,
        reason: `P12 contract environment advanced Goal to ${nextState}`,
        guards: { [guard]: true },
      }),
    });
    return { status: response.status, body: await response.json() };
  }, { organizationId, projectId, goalId, nextState, guard });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

test("Goal to Delivery Report uses the real app, PostgreSQL, audits, and external fakes", async ({
  context,
  page,
}) => {
  await installP12Session(context);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "研发工作台" })).toBeVisible();
  const workbenchResponse = await context.request.get(
    `${baseURL}/api/v1/workbench?limit=50`,
  );
  expect(
    workbenchResponse.status(),
    await workbenchResponse.text(),
  ).toBe(200);
  await page.getByRole("button", { name: "创建新目标" }).click();
  await page.getByLabel("目标标题").fill("P12 production release proof");
  await page.getByLabel("问题陈述").fill("The complete production path lacks one browser proof.");
  await page.getByLabel("期望结果").fill("A traceable Goal reaches an accepted Delivery Report.");
  await page.getByLabel("验收标准").fill("The browser and database prove the full release path");
  await page.getByLabel("非目标").fill("Public multi-tenant launch");
  await page.getByLabel("约束").fill("No production credentials");
  await page.getByRole("button", { name: "创建 Goal Contract" }).click();
  await expect(page.getByText("草稿已保存")).toBeVisible();
  const goalId = await page.evaluate(({ organizationId, projectId }) =>
    localStorage.getItem(
      `goal-workspace:draft:${organizationId}:${projectId}:last-goal`,
    ), { organizationId, projectId });
  expect(goalId).toBeTruthy();

  await page.getByRole("button", { name: "进入澄清阶段" }).click();
  await page.getByRole("button", { name: "生成澄清问题" }).click();
  const answer = page.getByLabel(/Who owns the production outcome.*人工答案/);
  await expect(answer).toBeVisible();
  await answer.fill("P12 release owner");
  await page.getByRole("button", { name: "提交新答案版本" }).click();
  await expect(page.getByText("当前答案：")).toBeVisible();
  await page.getByRole("button", { name: "锁定规划合同" }).click();
  await page.getByRole("button", { name: "生成 Proposal / PRD" }).click();
  await expect(page.getByRole("heading", { name: "Proposal / PRD 修订对比" })).toBeVisible();
  await page.getByLabel("审批或修改理由").fill("P12 specification is traceable");
  await page.getByRole("button", { name: "提交人工评审" }).click();
  await page.getByRole("button", { name: "批准最小合同" }).click();
  await expect(page.getByRole("button", { name: "批准最小合同" })).toBeHidden();
  const staleApproval = await page.evaluate(async ({
    organizationId,
    projectId,
    goalId,
  }) => {
    const query = new URLSearchParams({ organizationId, projectId });
    const revisionsResponse = await fetch(`/api/v1/goals/${goalId}/specs?${query}`);
    const revisions = (await revisionsResponse.json()).data.revisions;
    const latest = revisions.at(-1).specRevision;
    const approvalUrl =
      `/api/v1/goals/${goalId}/specs/${latest.id}/approvals`;
    const before = (await (await fetch(`${approvalUrl}?${query}`)).json())
      .data.decisions.length;
    const response = await fetch(approvalUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "p12-stale-spec-approval",
        "x-request-id": "p12-stale-spec-approval",
      },
      body: JSON.stringify({
        organizationId,
        projectId,
        expectedVersion: latest.version - 1,
        reason: "This stale browser approval must preserve the approved revision",
        policyRevision: latest.overdesignPolicyRevision,
        decision: "approve",
        affectedItemIds: latest.overdesignReview.items.map(
          (item: { elementId: string }) => item.elementId,
        ),
        payload: { helpfulExceptionElementIds: [], scopeChanges: [] },
      }),
    });
    const error = await response.json();
    const after = (await (await fetch(`${approvalUrl}?${query}`)).json())
      .data.decisions.length;
    return { status: response.status, error, before, after };
  }, { organizationId, projectId, goalId });
  expect(staleApproval.status).toBe(409);
  expect(staleApproval.error.error.code).toBe("version_conflict");
  expect(staleApproval.error.error.preservedState).toContain("remain unchanged");
  expect(staleApproval.after).toBe(staleApproval.before);
  await transitionGoal(page, goalId, "approved", "specApproved");

  await page.getByRole("button", { name: /进入 Issue 编译/ }).click();
  await expect(page.getByRole("heading", { name: "Issue Compiler 与执行合同" })).toBeVisible();
  await page.getByRole("button", { name: /批准 1 个 Issue/ }).click();
  await expect(page.getByText("方案已批准并锁定")).toBeVisible();
  await transitionGoal(page, goalId, "executing", "issuesApproved");
  const projectionResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().includes("/queue-projections"));
  await page.getByRole("button", { name: "通过正式 Import 投影" }).click();
  const projectionResponse = await projectionResponsePromise;
  expect(
    projectionResponse.status(),
    await projectionResponse.text(),
  ).toBe(200);
  const projectionReplays = await page.evaluate(async ({
    organizationId,
    projectId,
    goalId,
  }) => {
    const query = new URLSearchParams({ organizationId, projectId });
    const timeline = (await (await fetch(
      `/api/v1/goals/${goalId}/issue-plans?${query}`,
    )).json()).data;
    const plan = timeline.plans.at(-1);
    const url = `/api/v1/goals/${goalId}/issue-plans/${plan.id}/queue-projections`;
    return await Promise.all(["duplicate-click-a", "duplicate-click-b"].map(
      async (requestId) => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `issue-plan:${plan.id}:${plan.digest}`,
            "x-request-id": requestId,
          },
          body: JSON.stringify({
            organizationId,
            projectId,
            expectedVersion: plan.version,
          }),
        });
        return { status: response.status, body: await response.json() };
      },
    ));
  }, { organizationId, projectId, goalId });
  expect(projectionReplays.map(({ status }) => status)).toEqual([200, 200]);
  expect(projectionReplays[0].body.data.importId).toBe(
    projectionReplays[1].body.data.importId,
  );
  await expect(page.getByRole("heading", { name: "Production V1 自动开发" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Artifact 与 Git 交付证据" })).toBeVisible();
  await expect(page.getByRole("link", { name: "#12 · open" })).toBeVisible();
  await transitionGoal(page, goalId, "verifying", "allIssuesCompleted");

  await page.getByRole("button", { name: "查看目标验收 →" }).click();
  await expect(page.getByRole("heading", { name: "P12 production release proof" })).toBeVisible();
  await page.getByRole("button", { name: "运行最终验收" }).click();
  await expect(page.getByText("1 / 1 通过")).toBeVisible();
  await page.getByRole("button", { name: "生成 Delivery Report" }).click();
  await expect(page.getByText("等待人工最终验收")).toBeVisible();
  await page.getByLabel("Final acceptance reason").fill(
    "P12 browser, audit, evidence and external contract checks passed",
  );
  const acceptanceResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().includes("/acceptances"));
  await page.getByRole("button", { name: "Approver 最终验收" }).click();
  const acceptanceResponse = await acceptanceResponsePromise;
  expect(
    acceptanceResponse.status(),
    await acceptanceResponse.text(),
  ).toBe(200);
  await expect(page.getByText("目标已经达成")).toBeVisible();

  const pool = new Pool({ connectionString: process.env.P12_E2E_DATABASE_URL, max: 1 });
  try {
    const proof = await pool.query(
      `SELECT g.status,g.version,
              (SELECT count(*)::int FROM clarification_rounds WHERE goal_id=g.id) AS rounds,
              (SELECT count(*)::int FROM clarifications WHERE goal_id=g.id) AS clarifications,
              (SELECT count(*)::int FROM decisions WHERE goal_id=g.id) AS decisions,
              (SELECT count(*)::int FROM audit_events WHERE goal_id=g.id) AS audits,
              (SELECT count(*)::int FROM issue_plan_revisions WHERE goal_id=g.id AND status='approved') AS approved_plans,
              (SELECT count(*)::int FROM queue_projections WHERE goal_id=g.id AND status='completed') AS projections,
              (SELECT count(*)::int FROM acceptance_verification_plans WHERE goal_id=g.id) AS verification_plans,
              (SELECT count(*)::int FROM goal_verifications WHERE goal_id=g.id AND verdict='passed') AS verifications,
              (SELECT count(*)::int FROM delivery_reports WHERE goal_id=g.id) AS reports
         FROM goals g WHERE g.id=$1`,
      [goalId],
    );
    expect(proof.rows[0]).toMatchObject({
      status: "completed",
      rounds: 1,
      clarifications: 2,
      approved_plans: 1,
      projections: 1,
      verification_plans: 1,
      verifications: 1,
      reports: 2,
    });
    expect(proof.rows[0].decisions).toBeGreaterThanOrEqual(3);
    expect(proof.rows[0].audits).toBeGreaterThanOrEqual(8);
  } finally {
    await pool.end();
  }
});
