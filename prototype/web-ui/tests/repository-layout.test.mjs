import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findNestedGitRepositories,
  repositoryRoot,
} from "../../../scripts/check-single-git-repository.mjs";

test("the project contains no nested Git repository metadata", () => {
  assert.deepEqual(findNestedGitRepositories(repositoryRoot), []);
});

test("the repository rule detects a nested .git directory", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "harness-repository-rule-"));
  try {
    mkdirSync(join(fixtureRoot, ".git"));
    mkdirSync(join(fixtureRoot, "prototype", "web-ui", ".git"), {
      recursive: true,
    });

    assert.deepEqual(findNestedGitRepositories(fixtureRoot), [
      join(fixtureRoot, "prototype", "web-ui", ".git"),
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
