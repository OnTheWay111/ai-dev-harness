import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeIssueConflicts,
  scheduleExecutionWaves,
} from "../app/control-plane/domain/execution-waves.ts";

function issue(key, dependencies = [], overrides = {}) {
  return {
    key,
    dependencyCandidates: dependencies,
    expectedFiles: [`app/${key.toLowerCase()}.ts`],
    conflictResources: {
      directories: [],
      publicInterfaces: [],
      databaseObjects: [],
      sharedConfigurations: [],
      landingOrder: [],
    },
    ...overrides,
  };
}

test("P6-03 schedules stable waves only when dependencies and conflicts allow parallelism", () => {
  const issues = [
    issue("DEV-03", ["DEV-01"]),
    issue("DEV-02", ["DEV-01"]),
    issue("DEV-01"),
    issue("DEV-04", ["DEV-02", "DEV-03"]),
  ];
  const result = scheduleExecutionWaves(issues);
  assert.deepEqual(result.waves.map(({ issueKeys }) => issueKeys), [
    ["DEV-01"],
    ["DEV-02", "DEV-03"],
    ["DEV-04"],
  ]);
  assert.deepEqual(result.conflicts, []);
});

test("P6-03 explains file, directory, API, database, config, and landing conflicts", () => {
  const left = issue("A", [], {
    expectedFiles: ["app/shared.ts"],
    conflictResources: {
      directories: ["db/migrations/"],
      publicInterfaces: ["api.users.v1"],
      databaseObjects: ["public.users"],
      sharedConfigurations: ["tsconfig"],
      landingOrder: ["schema-before-code"],
    },
  });
  const right = issue("B", [], {
    expectedFiles: ["app/shared.ts", "db/migrations/002.sql"],
    conflictResources: structuredClone(left.conflictResources),
  });
  const conflicts = analyzeIssueConflicts([right, left]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].issueKeys, ["A", "B"]);
  assert.deepEqual(new Set(conflicts[0].resourceKinds), new Set([
    "file", "directory", "public_interface", "database_object",
    "shared_configuration", "landing_order",
  ]));
  assert.ok(conflicts[0].reasons.every((reason) => reason.length > 5));
  assert.deepEqual(
    scheduleExecutionWaves([right, left]).waves.map(({ issueKeys }) => issueKeys),
    [["A"], ["B"]],
  );
});

test("P6-03 avoids path-prefix false positives", () => {
  const conflicts = analyzeIssueConflicts([
    issue("A", [], { expectedFiles: ["app/foo.ts"] }),
    issue("B", [], { expectedFiles: ["app/foobar.ts"] }),
  ]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(
    scheduleExecutionWaves([
      issue("B", [], { expectedFiles: ["app/foobar.ts"] }),
      issue("A", [], { expectedFiles: ["app/foo.ts"] }),
    ]).waves[0].issueKeys,
    ["A", "B"],
  );
});
