import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  validateRunbookDocument,
  validateRunbookDrillReceipt,
  validateRunbookManifest,
} from "../app/reliability/runbook-catalog.ts";

const manifestUrl = new URL(
  "../../../ops/production/runbook-manifest.json",
  import.meta.url,
);
const repositoryRoot = new URL("../../../", import.meta.url);
const drillReceiptUrl = new URL(
  "../../../docs/evidence/p11-runbook-drill-2026-08-05.json",
  import.meta.url,
);

const requiredRunbooks = [
  "credential-rotation-security-incident",
  "data-repair",
  "database-object-recovery",
  "deployment-rollback-upgrade",
  "execution-stop-worker-loss",
  "on-call",
];

test("P11 catalog covers every production operation with owner and escalation", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  validateRunbookManifest(manifest);
  assert.deepEqual(manifest.runbooks.map((item) => item.id).sort(), requiredRunbooks);
  assert.deepEqual(manifest.requiredSections, [
    "触发条件", "权限", "执行命令", "验证", "回退", "升级联系人",
  ]);
  assert.equal(manifest.drill.minimumIndependentExecutions, 1);
  assert.ok(manifest.runbooks.every((item) =>
    item.owner && item.escalation.includes("incident-commander")));
});

test("P11 Runbooks have copyable commands and no embedded Secret", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  for (const runbook of manifest.runbooks) {
    const text = await readFile(new URL(`../../../${runbook.path}`, import.meta.url), "utf8");
    const result = validateRunbookDocument(runbook, text, manifest.requiredSections);
    assert.ok(result.commandBlocks >= 1, runbook.id);
    assert.equal(result.secretLiteralCount, 0, runbook.id);
  }
});

test("P11 rejects missing sections and credentials embedded in commands", () => {
  const runbook = {
    id: "fixture",
    path: "docs/runbooks/fixture.md",
    owner: "fixture-owner",
    escalation: ["incident-commander"],
  };
  assert.throws(() => validateRunbookDocument(runbook,
    "# Fixture\n\n## 触发条件\n\n```bash\nexport API_TOKEN='plaintext'\n```\n",
    ["触发条件", "权限", "执行命令", "验证", "回退", "升级联系人"]),
  /missing sections|secret/i);
});

test("P11 isolated Stop and Worker-loss drill requires an independent executor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p11-runbook-test-"));
  const output = join(directory, "receipt.json");
  const script = new URL("../scripts/run-runbook-drill.ts", import.meta.url).pathname;
  try {
    const sameRole = spawnSync(process.execPath,
      ["--experimental-strip-types", script, "--output", output], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNBOOK_DRILL_AUTHOR_ROLE: "platform-engineering",
          RUNBOOK_DRILL_EXECUTOR_ROLE: "platform-engineering",
        },
      });
    assert.equal(sameRole.status, 1);
    assert.match(sameRole.stderr, /independent/i);

    const independent = spawnSync(process.execPath,
      ["--experimental-strip-types", script, "--output", output], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNBOOK_DRILL_AUTHOR_ROLE: "platform-engineering",
          RUNBOOK_DRILL_EXECUTOR_ROLE: "independent-on-call-verifier",
          RUNBOOK_DRILL_REVISION_NOTE: "Fixture execution clarified the isolated drill evidence path.",
        },
      });
    assert.equal(independent.status, 0, independent.stderr);
    const receipt = JSON.parse(await readFile(output, "utf8"));
    validateRunbookDrillReceipt(receipt);
    assert.equal(receipt.result, "passed");
    assert.equal(receipt.executor.independent, true);
    assert.equal(receipt.scenario, "stop-and-worker-loss");
    assert.equal(receipt.assertions.noDuplicateLaunch, true);
    assert.equal(receipt.assertions.stopAudited, true);
    assert.equal(receipt.assertions.workerLeaseExpired, true);
    assert.ok(receipt.revisions.length >= 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("P11 committed independent drill Receipt binds the exact reviewed documents", async () => {
  const receipt = JSON.parse(await readFile(drillReceiptUrl, "utf8"));
  validateRunbookDrillReceipt(receipt);
  for (const [path, expected] of [
    [receipt.evidence.manifest, receipt.evidence.manifestSha256],
    [receipt.evidence.runbook, receipt.evidence.runbookSha256],
  ]) {
    const bytes = await readFile(new URL(`../../../${path}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  }
});
