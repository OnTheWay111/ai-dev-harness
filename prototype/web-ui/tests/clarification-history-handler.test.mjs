import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClarificationHistoryHandler } from "../app/control-plane/http/clarification-history-handler.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";
const goalId = "30000000-0000-4000-8000-000000000001";

function request(body, headers = {}) {
  return new Request(`https://harness.test/api/v1/goals/${goalId}/clarifications`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://harness.test", ...headers },
    body: JSON.stringify(body),
  });
}

test("handler derives actor from the OIDC principal and rejects client actor fields", async () => {
  let command;
  const handler = createClarificationHistoryHandler({
    actorResolver: async () => ({ actorId: "trusted-actor" }),
    service: {
      async timeline() { return { rounds: [], questions: [], decisions: [] }; },
      async generate(value) { command = value; return { round: {}, questions: [] }; },
      async answer() { throw new Error("unused"); },
    },
  });
  const invalid = await handler(request({ organizationId, projectId, expectedGoalVersion: 1, reason: "Generate", actorId: "attacker" }), goalId);
  assert.equal(invalid.status, 400);
  const accepted = await handler(request({ organizationId, projectId, expectedGoalVersion: 1, reason: "Generate" }), goalId);
  assert.equal(accepted.status, 201);
  assert.equal(command.actorId, "trusted-actor");
});

test("write requests fail before application code for cross-origin and missing identity", async () => {
  let calls = 0;
  const handler = createClarificationHistoryHandler({
    actorResolver: async () => null,
    service: {
      async timeline() { calls++; return { rounds: [], questions: [], decisions: [] }; },
      async generate() { calls++; throw new Error("unreachable"); },
      async answer() { calls++; throw new Error("unreachable"); },
    },
  });
  const crossOrigin = request({ organizationId, projectId, expectedGoalVersion: 1, reason: "Generate" }, { origin: "https://evil.test" });
  assert.equal((await handler(crossOrigin, goalId)).status, 403);
  assert.equal((await handler(request({ organizationId, projectId, expectedGoalVersion: 1, reason: "Generate" }), goalId)).status, 401);
  assert.equal(calls, 0);
});

test("UI exposes an accessible answer control and the immutable timeline", async () => {
  const source = await readFile(
    new URL("../app/workbench/components/clarify-view.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /aria-label=\{`\$\{question\.prompt\} 的人工答案`\}/);
  assert.match(source, /aria-label="澄清历史时间线"/);
  assert.match(source, /重新回答（将创建新版本）/);
  assert.match(source, /decision\.actorId/);
});
