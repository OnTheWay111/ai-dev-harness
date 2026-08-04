import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkbenchTaskRows,
} from "../app/workbench/server/neon-workbench-projection-writer.ts";

test("builds ordered PostgreSQL projection rows from the contract snapshot", () => {
  const tasks = [
    {
      id: "DEV-07",
      goalId: "GOAL-2407",
      priority: "P0",
      stage: "review",
      attention: { required: true },
      progress: { updatedAt: "2026-08-03T06:32:00.000Z" },
    },
    {
      id: "DEV-06",
      goalId: "GOAL-2407",
      priority: "P1",
      stage: "running",
      attention: { required: false },
      progress: { updatedAt: "2026-08-03T06:31:00.000Z" },
    },
  ];

  const rows = buildWorkbenchTaskRows({
    scopeId: "development",
    organizationId: "10000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000001",
  }, { tasks });

  assert.deepEqual(
    rows.map((row) => ({
      scopeId: row.scopeId,
      organizationId: row.organizationId,
      projectId: row.projectId,
      taskId: row.taskId,
      goalId: row.goalId,
      priority: row.priority,
      stage: row.stage,
      attentionRequired: row.attentionRequired,
      rank: row.rank,
      updatedAt: row.updatedAt.toISOString(),
    })),
    [
      {
        scopeId: "development",
        organizationId: "10000000-0000-4000-8000-000000000001",
        projectId: "20000000-0000-4000-8000-000000000001",
        taskId: "DEV-07",
        goalId: "GOAL-2407",
        priority: "P0",
        stage: "review",
        attentionRequired: true,
        rank: 0,
        updatedAt: "2026-08-03T06:32:00.000Z",
      },
      {
        scopeId: "development",
        organizationId: "10000000-0000-4000-8000-000000000001",
        projectId: "20000000-0000-4000-8000-000000000001",
        taskId: "DEV-06",
        goalId: "GOAL-2407",
        priority: "P1",
        stage: "running",
        attentionRequired: false,
        rank: 1,
        updatedAt: "2026-08-03T06:31:00.000Z",
      },
    ],
  );
});
