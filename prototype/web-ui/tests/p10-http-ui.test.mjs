import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createGoalVerificationHandlers } from
  "../app/control-plane/http/goal-verification-handler.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const goalId = "00000000-0000-4000-8000-000000000003";

function handlers(overrides = {}) {
  return createGoalVerificationHandlers({
    plans: {
      async timeline() { return [{ id: "plan-1" }]; },
      async compile(command) { return { id: "plan-2", command }; },
    },
    verifications: {
      async timeline() { return [{ id: "verification-1" }]; },
      async verify(command) { return { id: "verification-2", command }; },
    },
    gaps: {
      async timeline() { return []; },
      async create(command) { return { id: "gap-1", command }; },
      async confirm(command) { return { reportId: command.reportId }; },
    },
    reports: {
      async timeline() { return [{ id: "report-1" }]; },
      async generate(command) { return { id: "report-2", command }; },
      async accept(command) { return { report: { id: command.reportId }, goal: { status: "completed" } }; },
      async export() { return { fileName: "delivery-report.json", mediaType: "application/json", body: "{\"ok\":true}" }; },
    },
    actorResolver: async () => ({ actorId: "actor-1" }),
    allowedOrigins: ["https://harness.test"],
    rateLimiter: { consume() {} },
    ...overrides,
  });
}

function request(path, init = {}) {
  return new Request(`https://harness.test${path}`, init);
}

function write(body) {
  return {
    method: "POST",
    headers: {
      origin: "https://harness.test",
      "content-type": "application/json",
      "x-request-id": "request-p10",
      "idempotency-key": "idempotency-p10",
    },
    body: JSON.stringify(body),
  };
}

test("P10 HTTP API reads timelines and compiles a closed verification plan", async () => {
  const api = handlers();
  const timeline = await api.plans(request(
    `/api/v1/goals/${goalId}/verification-plans?organizationId=${organizationId}&projectId=${projectId}`,
  ), goalId);
  assert.equal(timeline.status, 200);
  assert.deepEqual((await timeline.json()).data, [{ id: "plan-1" }]);

  const compiled = await api.plans(request(
    `/api/v1/goals/${goalId}/verification-plans`,
    write({
      organizationId,
      projectId,
      issuePlanId: "00000000-0000-4000-8000-000000000004",
      expectedGoalVersion: 8,
      expectedIssuePlanVersion: 2,
      draft: { schemaVersion: "acceptance-verification-plan-draft.v1", entries: [] },
    }),
  ), goalId);
  assert.equal(compiled.status, 200);
  assert.equal((await compiled.json()).data.command.actorId, "actor-1");

  const unknown = await api.plans(request(
    `/api/v1/goals/${goalId}/verification-plans`,
    write({ organizationId, projectId, unknown: true }),
  ), goalId);
  assert.equal(unknown.status, 400);
});

test("P10 HTTP API preserves state on verifier errors and exports reports as private attachments", async () => {
  const api = handlers({
    verifications: {
      async timeline() { return []; },
      async verify() { throw new Error("verifier unavailable"); },
    },
  });
  const failed = await api.verifications(request(
    `/api/v1/goals/${goalId}/verifications`,
    write({
      organizationId,
      projectId,
      planId: "00000000-0000-4000-8000-000000000005",
      expectedGoalVersion: 8,
      manualEvidence: [],
    }),
  ), goalId);
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error.preservedState, /immutable/i);

  const exported = await api.reportExport(request(
    `/api/v1/goals/${goalId}/delivery-reports/00000000-0000-4000-8000-000000000006/export?organizationId=${organizationId}&projectId=${projectId}`,
  ), goalId, "00000000-0000-4000-8000-000000000006");
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition"), /delivery-report\.json/);
  assert.equal(exported.headers.get("cache-control"), "private, no-store");
});

test("P10 HTTP API rejects open or malformed manual-evidence entries", async () => {
  const api = handlers();
  for (const manualEvidence of [
    [{ entryId: "manual-1", evidenceRef: "artifact:1", reason: "Approved", extra: true }],
    [{ entryId: "manual-1", evidenceRef: "", reason: "Approved" }],
    [{ entryId: 1, evidenceRef: "artifact:1", reason: "Approved" }],
  ]) {
    const response = await api.verifications(request(
      `/api/v1/goals/${goalId}/verifications`,
      write({
        organizationId,
        projectId,
        planId: "00000000-0000-4000-8000-000000000005",
        expectedGoalVersion: 8,
        manualEvidence,
      }),
    ), goalId);
    assert.equal(response.status, 400);
  }
});

test("P10 HTTP API rejects open or malformed known-risk entries", async () => {
  const api = handlers();
  for (const knownRisks of [
    [{ severity: "low", statement: "Monitor it", disposition: "monitor", extra: true }],
    [{ severity: "unknown", statement: "Monitor it", disposition: "monitor" }],
    [{ severity: "low", statement: "", disposition: "monitor" }],
  ]) {
    const response = await api.reports(request(
      `/api/v1/goals/${goalId}/delivery-reports`,
      write({
        organizationId,
        projectId,
        verificationId: "00000000-0000-4000-8000-000000000005",
        knownRisks,
      }),
    ), goalId);
    assert.equal(response.status, 400);
  }
});

test("P10 UI consumes authoritative verification APIs without local fake completion", async () => {
  const root = new URL("../app/workbench/", import.meta.url);
  const [view, app, api] = await Promise.all([
    readFile(new URL("components/verify-view.tsx", root), "utf8"),
    readFile(new URL("components/workbench-app.tsx", root), "utf8"),
    readFile(new URL("goal-verification-api.ts", root), "utf8"),
  ]);
  assert.match(app, /goalId=\{issuePlanContext\?\.goalId \?\? restoredGoalId/);
  assert.match(view, /goalVerificationApi\.verify/);
  assert.match(view, /createGap/);
  assert.match(view, /generateReport/);
  assert.match(view, /acceptReport/);
  assert.match(view, /exportUrl/);
  assert.doesNotMatch(view, /setVerified/);
  assert.match(api, /verification-plans/);
  assert.match(api, /delivery-reports/);
});
