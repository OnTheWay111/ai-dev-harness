import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
  buildPlannerContextPacket,
  PlannerExecutionError,
} from "../app/control-plane/ports/planner-port.ts";
import {
  CodexPlannerAdapter,
} from "../app/control-plane/adapters/codex-planner-adapter.ts";
import {
  FakePlannerAdapter,
} from "../app/control-plane/adapters/fake-planner-adapter.ts";

const goal = {
  id: "00000000-0000-4000-8000-000000000301",
  organizationId: "00000000-0000-4000-8000-000000000302",
  projectId: "00000000-0000-4000-8000-000000000303",
  title: "Clarify a production Goal",
  problemStatement: "The request has unresolved decisions.",
  desiredOutcome: "Ask only questions that change scope or risk.",
  acceptanceCriteria: [
    { id: "ac-1", position: 1, statement: "Questions are structured", version: 1 },
  ],
  nonGoals: ["Approve the Goal automatically"],
  constraints: ["Read-only planning"],
  status: "clarifying",
  version: 3,
  createdAt: "2026-08-04T10:00:00.000Z",
  updatedAt: "2026-08-04T11:00:00.000Z",
};

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string" } },
};

test("builds the minimum Goal context without tenant, actor, or repository metadata", () => {
  assert.deepEqual(buildPlannerContextPacket(goal), {
    contractVersion: "goal-context.v1",
    goalId: goal.id,
    goalVersion: 3,
    title: goal.title,
    problemStatement: goal.problemStatement,
    desiredOutcome: goal.desiredOutcome,
    acceptanceCriteria: ["Questions are structured"],
    nonGoals: goal.nonGoals,
    constraints: goal.constraints,
  });
  const serialized = JSON.stringify(buildPlannerContextPacket(goal));
  assert.doesNotMatch(serialized, /organizationId|projectId|actor|repository/i);
});

test("fake adapter follows the PlannerPort draft contract", async () => {
  const fake = new FakePlannerAdapter([{ summary: "Need deployment boundary" }]);
  const result = await fake.plan({ goal, outputSchema });
  assert.equal(result.status, "draft");
  assert.equal(result.goalId, goal.id);
  assert.equal(result.sourceGoalVersion, 3);
  assert.deepEqual(result.output, { summary: "Need deployment boundary" });
  assert.equal(fake.requests.length, 1);
});

test("Codex adapter starts isolated fresh sessions with array args and minimal env", async () => {
  const requests = [];
  let run = 0;
  const adapter = new CodexPlannerAdapter({
    command: "/opt/bin/codex",
    environment: {
      PATH: "/opt/bin",
      NVM_BIN: "/opt/node/bin",
      HOME: "/safe/home",
      DATABASE_URL: "must-not-pass",
      OIDC_COOKIE_SECRET: "must-not-pass",
    },
    runner: async (request) => {
      requests.push(request);
      run += 1;
      await writeFile(request.outputPath, JSON.stringify({ summary: `draft-${run}` }));
      return { exitCode: 0, timedOut: false, stdoutBytes: 0, stderrBytes: 0 };
    },
  });

  const first = await adapter.plan({ goal, outputSchema });
  const second = await adapter.plan({ goal, outputSchema });
  assert.deepEqual(first.output, { summary: "draft-1" });
  assert.deepEqual(second.output, { summary: "draft-2" });
  assert.notEqual(first.plannerRunId, second.plannerRunId);
  assert.notEqual(requests[0].cwd, requests[1].cwd);
  for (const request of requests) {
    assert.equal(request.command, "/opt/bin/codex");
    assert.deepEqual(request.environment, {
      PATH: "/opt/node/bin:/opt/bin",
      HOME: "/safe/home",
    });
    assert.deepEqual(request.args.slice(0, 7), [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
    ]);
    assert.ok(request.args.includes("--output-schema"));
    assert.ok(request.args.includes("--output-last-message"));
    assert.equal(request.args.at(-1), "-");
    assert.doesNotMatch(request.args.join(" "), /Clarify a production Goal/);
    assert.match(request.stdin, /Clarify a production Goal/);
    assert.doesNotMatch(request.stdin, /organizationId|projectId|DATABASE_URL/);
    assert.equal(request.timeoutMs, 30_000);
    assert.equal(request.maxOutputBytes, 256 * 1024);
  }
});

test("Codex adapter diagnoses timeout, non-zero exit, and illegal output without leaking it", async () => {
  for (const [result, code] of [
    [{ exitCode: null, timedOut: true, stdoutBytes: 0, stderrBytes: 12 }, "planner_timeout"],
    [{ exitCode: 9, timedOut: false, stdoutBytes: 0, stderrBytes: 12 }, "planner_failed"],
  ]) {
    const adapter = new CodexPlannerAdapter({
      runner: async () => result,
      environment: { PATH: "/bin", HOME: "/safe" },
    });
    await assert.rejects(
      () => adapter.plan({ goal, outputSchema }),
      (error) => error instanceof PlannerExecutionError && error.code === code &&
        !error.message.includes("secret process output"),
    );
  }

  const invalid = new CodexPlannerAdapter({
    runner: async (request) => {
      await writeFile(request.outputPath, "secret process output: not JSON");
      return { exitCode: 0, timedOut: false, stdoutBytes: 0, stderrBytes: 0 };
    },
    environment: { PATH: "/bin", HOME: "/safe" },
  });
  await assert.rejects(
    () => invalid.plan({ goal, outputSchema }),
    (error) => error instanceof PlannerExecutionError &&
      error.code === "planner_invalid_output" &&
      !error.message.includes("secret process output"),
  );
});

test("enforces context/output budgets and emits metadata-only logs", async () => {
  let calls = 0;
  const contextLimited = new CodexPlannerAdapter({
    maxContextBytes: 10,
    runner: async () => {
      calls += 1;
      throw new Error("must not start");
    },
  });
  await assert.rejects(
    () => contextLimited.plan({ goal, outputSchema }),
    (error) => error instanceof PlannerExecutionError &&
      error.code === "planner_budget_exceeded",
  );
  assert.equal(calls, 0);

  const logs = [];
  const outputLimited = new CodexPlannerAdapter({
    logger: (event) => logs.push(event),
    runner: async () => ({
      exitCode: null,
      timedOut: false,
      stdoutBytes: 300_000,
      stderrBytes: 0,
      outputLimitExceeded: true,
    }),
  });
  await assert.rejects(
    () => outputLimited.plan({ goal, outputSchema }),
    (error) => error instanceof PlannerExecutionError &&
      error.code === "planner_budget_exceeded",
  );
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), [
    "durationMs",
    "event",
    "exitCode",
    "plannerRunId",
    "stderrBytes",
    "stdoutBytes",
    "timedOut",
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /Clarify|Goal context|secret|tmp/i);
});
