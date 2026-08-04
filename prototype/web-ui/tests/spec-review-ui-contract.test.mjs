import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("revision comparison exposes keyboard-native controls and structured changes", () => {
  const comparison = source("../app/workbench/components/spec-revision-comparison.tsx");
  assert.match(comparison, /aria-label="规格修订列表"/);
  assert.match(comparison, /type="button"/);
  assert.match(comparison, /aria-pressed=/);
  assert.match(comparison, /与前序修订的结构化差异/);
  assert.match(comparison, /change\.before/);
  assert.match(comparison, /change\.after/);
});

test("review UI keeps stale revisions read-only and does not infer approval permission", () => {
  const view = source("../app/workbench/components/clarify-view.tsx");
  const panel = source("../app/workbench/components/spec-approval-panel.tsx");
  assert.match(view, /specRevision\.id !== latestSpec\?\.specRevision\.id/);
  assert.match(panel, /权限由服务端判断/);
  assert.match(panel, /disabled=\{busy \|\| readOnly/);
  assert.doesNotMatch(`${view}\n${panel}`, /canApprove|permission\.includes|role\s*===/);
});

test("review failures explicitly restore all user-owned draft fields", () => {
  const view = source("../app/workbench/components/clarify-view.tsx");
  assert.match(view, /setApprovalReason\(preservedDraft\.reason\)/);
  assert.match(view, /setHelpfulExceptions\(preservedDraft\.helpfulExceptionElementIds\)/);
  assert.match(view, /setScopeChange\(preservedDraft\.scopeChange\)/);
  assert.match(view, /caught\.code === "version_conflict"/);
});
