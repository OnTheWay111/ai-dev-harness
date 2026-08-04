import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskFilters,
  filterGlobalTasks,
} from "../app/workbench/selectors.ts";

const tasks = [
  { id: "A", stage: "review", attention: { required: true } },
  { id: "B", stage: "blocked", attention: { required: true } },
  { id: "C", stage: "waiting", attention: { required: false } },
  { id: "D", stage: "running", attention: { required: false } },
];

test("filters global tasks by attention and lifecycle stage", () => {
  assert.deepEqual(
    filterGlobalTasks(tasks, "attention").map((task) => task.id),
    ["A", "B"],
  );
  assert.deepEqual(
    filterGlobalTasks(tasks, "blocked").map((task) => task.id),
    ["B"],
  );
  assert.deepEqual(
    filterGlobalTasks(tasks, "all").map((task) => task.id),
    ["A", "B", "C", "D"],
  );
});

test("derives filter counts from the snapshot instead of hard-coding UI totals", () => {
  assert.deepEqual(
    buildTaskFilters(tasks).map(({ id, count }) => [id, count]),
    [
      ["all", 4],
      ["attention", 2],
      ["running", 1],
      ["review", 1],
      ["blocked", 1],
      ["waiting", 1],
    ],
  );
});

test("uses server counts when the current task page is incomplete", () => {
  const serverCounts = {
    all: 120,
    attention: 18,
    running: 7,
    review: 4,
    blocked: 6,
    waiting: 103,
  };

  assert.deepEqual(
    buildTaskFilters(tasks.slice(0, 2), serverCounts).map(({ id, count }) => [id, count]),
    Object.entries(serverCounts),
  );
});
