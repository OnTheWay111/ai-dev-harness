import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import { AutoDevQueueImportAdapter } from
  "../app/control-plane/adapters/autodev-queue-import-adapter.ts";
import { assertAutoDevExecutionContract } from
  "./execution-gateway-contract.mjs";

const repositorySourcePath = fileURLToPath(new URL("../../../autodev", import.meta.url));
const sourcePath = process.env.AUTODEV_SOURCE_PATH?.trim() || repositorySourcePath;
const python = process.env.AUTODEV_PYTHON?.trim() ||
  path.join(sourcePath, ".venv", "bin", "python");
const runtimeAvailable = existsSync(python);

const approvedPlan = {
  id: "00000000-0000-4000-8000-000000000610",
  organizationId: "00000000-0000-4000-8000-000000000601",
  projectId: "00000000-0000-4000-8000-000000000602",
  goalId: "00000000-0000-4000-8000-000000000603",
  status: "approved",
  digest: "6".repeat(64),
  issues: [
    {
      key: "P6-06A", title: "Atomic importer", goal: "Persist a complete plan",
      developmentPrompt: "Implement the complete approved P6-06A atomic import contract and run npm test successfully.",
      acceptance: [{ criterionRef: "AC-01", statement: "No partial tasks remain" }],
      verify: ["npm test"],
      completionEvidence: [{ kind: "test", description: "integration passes", required: true }],
      dependencyCandidates: [], expectedFiles: ["autodev/queue_import.py"],
    },
    {
      key: "P6-06B", title: "HTTP boundary", goal: "Expose the importer safely",
      developmentPrompt: "Implement the approved P6-06B authenticated HTTP contract after P6-06A and run npm test.",
      acceptance: [{ criterionRef: "AC-02", statement: "Return an exact receipt" }],
      verify: ["npm test"],
      completionEvidence: [{ kind: "test", description: "HTTP integration passes", required: true }],
      dependencyCandidates: ["P6-06A"], expectedFiles: ["autodev/queue_import_http.py"],
    },
  ],
  modelRecommendations: [
    { issueKey: "P6-06A", capabilityTier: "advanced_coding", reasoningEffort: "high", policyRevision: "model-router.v1" },
    { issueKey: "P6-06B", capabilityTier: "frontier", reasoningEffort: "highest", policyRevision: "model-router.v1" },
  ],
  waves: [
    { number: 1, issueKeys: ["P6-06A"] },
    { number: 2, issueKeys: ["P6-06B"] },
  ],
};

function importBody(plan) {
  const routes = new Map(plan.modelRecommendations.map((route) => [route.issueKey, route]));
  return {
    schemaVersion: "autodev-queue-import.v1",
    atomic: true,
    issuePlanId: plan.id,
    planDigest: plan.digest,
    tasks: plan.issues.map((issue) => {
      const route = routes.get(issue.key);
      return {
        issueKey: issue.key, title: issue.title, goal: issue.goal,
        developmentPrompt: issue.developmentPrompt, acceptance: issue.acceptance,
        verify: issue.verify, completionEvidence: issue.completionEvidence,
        dependencies: issue.dependencyCandidates, expectedFiles: issue.expectedFiles,
        wave: plan.waves.find(({ issueKeys }) => issueKeys.includes(issue.key)).number,
        capabilityTier: route.capabilityTier, reasoningEffort: route.reasoningEffort,
        routingPolicyRevision: route.policyRevision,
      };
    }),
  };
}

async function startServer(python, configPath) {
  const child = spawn(
    python,
    ["-m", "autodev", "queue-import-server", "--project", configPath, "--port", "0"],
    {
      cwd: sourcePath,
      env: { ...process.env, AUTODEV_QUEUE_IMPORT_TOKEN: "integration-secret" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const endpoint = await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (!child.killed) child.kill("SIGTERM");
      reject(error);
    };
    const timeout = setTimeout(
      () => fail(new Error(`AutoDev server timeout: ${stderr}`)),
      10_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      fail(new Error(`AutoDev server exited ${code}: ${stderr}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/(http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(`${match[1]}/api/v1/queue/import`);
      }
    });
  });
  return { child, endpoint };
}

test("P6-06 projects through the real AutoDev atomic HTTP import boundary", {
  skip: runtimeAvailable ? false : "install autodev/.venv or set AUTODEV_PYTHON",
  timeout: 30_000,
}, async () => {
  const project = await mkdtemp(path.join(tmpdir(), "p6-06-autodev-"));
  const configPath = path.join(project, ".autodev", "project.yaml");
  const queuePath = path.join(project, "tasks", "agent_task_queue.yaml");
  let child;
  let endpoint;
  try {
    const initialized = spawnSync(
      python,
      ["-m", "autodev", "init", "--repo", project, "--project-id", "p6-06-integration"],
      { cwd: sourcePath, encoding: "utf8" },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    const initializedGit = spawnSync("git", ["init", "-b", "main"], {
      cwd: project, encoding: "utf8",
    });
    assert.equal(initializedGit.status, 0, initializedGit.stderr);
    const config = parse(await readFile(configPath, "utf8"));
    for (const capability of [
      "cost_optimized", "general_coding", "advanced_coding", "frontier",
    ]) {
      config.agent.commands[capability] = {
        kind: "command",
        command: "/usr/bin/true",
        args: [],
        fresh_session_per_task: true,
        timeout_minutes: 1,
        permissions: { profile: "autodev_builder", allow: [], deny: [] },
      };
    }
    await writeFile(configPath, stringify(config));
    ({ child, endpoint } = await startServer(python, configPath));

    const invalid = importBody(approvedPlan);
    invalid.tasks[1].capabilityTier = "silent_downgrade";
    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer integration-secret", "content-type": "application/json",
        "idempotency-key": "invalid-batch", "x-request-id": "invalid-request",
      },
      body: JSON.stringify(invalid),
    });
    assert.equal(rejected.status, 400);
    assert.equal(parse(await readFile(queuePath, "utf8")).tasks.length, 0);

    const adapter = new AutoDevQueueImportAdapter({
      endpoint,
      token: "integration-secret",
      clock: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    const first = await adapter.importApprovedPlan({
      plan: approvedPlan, requestId: "request-1", idempotencyKey: "projection-1",
    });
    const replay = await adapter.importApprovedPlan({
      plan: approvedPlan, requestId: "request-2", idempotencyKey: "projection-2",
    });
    assert.equal(first.importId, replay.importId);
    assert.deepEqual(first.tasks, [
      { issueKey: "P6-06A", externalTaskId: "H-001" },
      { issueKey: "P6-06B", externalTaskId: "H-002" },
    ]);

    const queue = parse(await readFile(queuePath, "utf8"));
    assert.equal(queue.tasks.length, 2);
    assert.deepEqual(queue.tasks[1].dependencies, ["H-001"]);
    assert.equal(queue.tasks[0].model_route.capability_tier, "advanced_coding");
    assert.equal(queue.tasks[0].preferred_builder, "advanced_coding");
    assert.match(queue.tasks[0].development_prompt, /approved P6-06A/);
    assert.equal(queue.imports.length, 1);

    const committed = spawnSync("git", ["add", "."], { cwd: project, encoding: "utf8" });
    assert.equal(committed.status, 0, committed.stderr);
    const commit = spawnSync(
      "git",
      ["-c", "user.name=AutoDev Test", "-c", "user.email=autodev@example.invalid",
        "commit", "-m", "fixture"],
      { cwd: project, encoding: "utf8" },
    );
    assert.equal(commit.status, 0, commit.stderr);
    const dryRun = spawnSync(
      python,
      ["-m", "autodev", "run-one", "--project", configPath, "--task", "H-001",
        "--run-id", "p7-real-smoke", "--dry-run", "--json"],
      { cwd: sourcePath, encoding: "utf8", env: { ...process.env } },
    );
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).status, "dry_run");
    const events = (await readFile(
      path.join(project, ".autodev", "runs", "p7-real-smoke", "events.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) =>
      event.phase === "dry_run" &&
      event.extra.preferred_builder === "advanced_coding"));

    const status = spawnSync(
      python,
      ["-m", "autodev", "status", "--project", configPath,
        "--run-id", "p7-real-smoke", "--json"],
      { cwd: sourcePath, encoding: "utf8" },
    );
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.run_id, "p7-real-smoke");
    assertAutoDevExecutionContract({
      queueTask: queue.tasks[0],
      status: statusPayload,
      events,
    });
  } finally {
    if (child && !child.killed) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    await rm(project, { recursive: true, force: true });
  }
});
