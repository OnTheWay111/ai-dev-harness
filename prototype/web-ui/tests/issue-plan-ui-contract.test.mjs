import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("P6-03/P6-05 UI exposes DAG, Wave, conflict, routing, and exact revision evidence", () => {
  const view = source("../app/workbench/components/issues-view.tsx");
  assert.match(view, /plan\.compilation\.diagnostics/);
  assert.match(view, /plan\.conflicts\.map/);
  assert.match(view, /wave\.reasons\.map/);
  assert.match(view, /capabilityTiers\.map/);
  assert.match(view, /reasoningEfforts\.map/);
  assert.match(view, /digest \{plan\.digest\.slice/);
  assert.match(view, /权限由服务端判断/);
});

test("P6-05 editing remains keyboard-native and restores drafts on 409 or network failure", () => {
  const view = source("../app/workbench/components/issues-view.tsx");
  assert.match(view, /aria-label=\{`\$\{issue\.key\} 标题`\}/);
  assert.match(view, /aria-label=\{`\$\{issue\.key\} 依赖`\}/);
  assert.match(view, /aria-pressed=\{mode === "table"\}/);
  assert.match(view, /setIssues\(preservedIssues\)/);
  assert.match(view, /setRoutes\(preservedRoutes\)/);
  assert.match(view, /const dirty = useMemo/);
  assert.match(view, /disabled=\{busy \|\| !plan\.compilation\.valid \|\| dirty\}/);
  assert.match(view, /caught\.code/);
  assert.doesNotMatch(view, /canApprove|role\s*===|permissions\.includes/);
});

test("P6-06 UI reports the formal import blocker without pretending tasks entered execution", () => {
  const view = source("../app/workbench/components/issues-view.tsx");
  const api = source("../app/workbench/issue-plan-api.ts");
  assert.match(view, /queue_import_unavailable/);
  assert.match(view, /未写入任何外部任务/);
  assert.match(view, /通过正式 Import 投影/);
  assert.match(api, /issue-plan:\$\{plan\.id\}:\$\{plan\.digest\}/);
});

test("P6 API routes expose collection, revision, approval, and projection boundaries", () => {
  for (const path of [
    "../app/api/v1/goals/[goalId]/issue-plans/route.ts",
    "../app/api/v1/goals/[goalId]/issue-plans/[planId]/route.ts",
    "../app/api/v1/goals/[goalId]/issue-plans/[planId]/approvals/route.ts",
    "../app/api/v1/goals/[goalId]/issue-plans/[planId]/queue-projections/route.ts",
  ]) {
    const route = source(path);
    assert.match(route, /readRequestPrincipal/);
    assert.match(route, /configuredWriteOrigins/);
  }
});
