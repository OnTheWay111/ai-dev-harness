import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresWorkbenchReadRepository,
} from "../app/workbench/server/postgres-workbench-repository.ts";

const summary = {
  metrics: [],
  taskCounts: {
    all: 7,
    attention: 4,
    running: 1,
    review: 1,
    blocked: 2,
    waiting: 3,
  },
};

const task = {
  id: "DEV-07",
  version: 12,
  goalId: "GOAL-2407",
  title: "Web 审批工作区",
  kind: "issue",
  priority: "P0",
  stage: "review",
  status: { code: "review", label: "Review", tone: "warning" },
  progress: { percent: 92, updatedAt: "2026-08-03T14:32:00+08:00" },
  attention: {
    required: true,
    count: 1,
    severity: "warning",
    headline: "权限边界例外待人工决定",
    rankingReason: "截止 15:00",
    impact: "影响发布门禁",
  },
  execution: {
    actorType: "worker",
    actorLabel: "W2 · Reviewer",
    elapsedSeconds: 1448,
    nextCheckpoint: "审查证据",
  },
  action: {
    id: "review_evidence",
    label: "审查证据",
    available: true,
  },
  detail: {
    dependency: "DEV-06",
    evidence: "3 项通过",
    workspace: "worktree/DEV-07",
  },
};

test("maps PostgreSQL projection rows into the workbench contract", async () => {
  const calls = [];
  const store = {
    async readPage(input) {
      calls.push({ method: "page", input });
      return {
        snapshot: {
          revision: 21,
          generatedAt: new Date("2026-08-03T06:32:00.000Z"),
          summary,
        },
        tasks: [task, { ...task, id: "DEV-08" }],
        total: 6,
      };
    },
  };
  const repository = new PostgresWorkbenchReadRepository(store, "org_demo");

  const result = await repository.getWorkbench({
    goalId: "GOAL-2407",
    filter: "attention",
    cursor: "wb1_2",
    limit: 2,
  });

  assert.equal(repository.kind, "postgres");
  assert.equal(result.data.schemaVersion, "workbench.v1");
  assert.equal(result.data.revision, 21);
  assert.equal(result.data.generatedAt, "2026-08-03T06:32:00.000Z");
  assert.deepEqual(result.data.tasks.map((item) => item.id), ["DEV-07", "DEV-08"]);
  assert.deepEqual(result.page, { nextCursor: "wb1_4", total: 6 });
  assert.deepEqual(calls[0], {
    method: "page",
    input: {
      scopeId: "org_demo",
      goalId: "GOAL-2407",
      filter: "attention",
      offset: 2,
      limit: 2,
    },
  });
});

test("does not silently serve empty data when the projection is missing", async () => {
  const store = {
    async readPage() {
      return { snapshot: null, tasks: [], total: 0 };
    },
  };
  const repository = new PostgresWorkbenchReadRepository(store, "org_missing");

  await assert.rejects(
    () => repository.getWorkbench(),
    /workbench snapshot is unavailable/i,
  );
});
