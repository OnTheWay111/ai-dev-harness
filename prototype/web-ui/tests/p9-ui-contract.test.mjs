import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("run center renders immutable artifact, review, commit, push, PR, and landing evidence", async () => {
  const root = new URL("../app/workbench/components/", import.meta.url);
  const [panel, runCenter] = await Promise.all([
    readFile(new URL("delivery-evidence-panel.tsx", root), "utf8"),
    readFile(new URL("run-center-view.tsx", root), "utf8"),
  ]);
  assert.match(runCenter, /DeliveryEvidencePanel/);
  assert.match(panel, /Artifact|证据/);
  assert.match(panel, /独立 Review/);
  assert.match(panel, /Commit/);
  assert.match(panel, /Push/);
  assert.match(panel, /PR/);
  assert.match(panel, /Landing/);
  assert.match(panel, /digest/i);
  assert.match(panel, /download|下载/i);
});
