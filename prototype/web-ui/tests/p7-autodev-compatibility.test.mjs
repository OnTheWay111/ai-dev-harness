import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const autodevRoot = new URL("../../../autodev/", import.meta.url);
const python = "python3";
const pythonPath = autodevRoot.pathname;

function run(arguments_) {
  return spawnSync(python, arguments_, {
    cwd: autodevRoot,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: pythonPath },
  });
}

test("P7 compatibility gate pins AutoDev and its machine-readable execution API", () => {
  const version = run(["-m", "autodev", "--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /autodev 0\.4\.16/);

  const controller = readFileSync(
    new URL("autodev/controller.py", autodevRoot), "utf8",
  );
  const runStore = readFileSync(
    new URL("autodev/run_store.py", autodevRoot), "utf8",
  );
  for (const option of ["--task", "--run-id", "--json"]) {
    assert.match(controller, new RegExp(option));
  }
  for (const option of ["--run-id", "--json"]) {
    assert.match(runStore, new RegExp(option));
  }
});

test("P7 compatibility gate requires task-level builder selection and event identity", () => {
  const queueImport = readFileSync(
    new URL("autodev/queue_import.py", autodevRoot), "utf8",
  );
  const runStore = readFileSync(
    new URL("autodev/run_store.py", autodevRoot), "utf8",
  );
  assert.match(queueImport, /preferred_builder/);
  assert.match(runStore, /event_id/);
  assert.match(runStore, /sequence/);
  assert.match(runStore, /autodev\.run-event\.v1/);
});
