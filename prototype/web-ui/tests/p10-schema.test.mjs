import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("P10 schema persists scoped append-only Plan, Verification, Gap, remediation, and Report chains", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/postgres-schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle-postgres/0019_small_phantom_reporter.sql", import.meta.url), "utf8"),
  ]);
  for (const table of [
    "acceptance_verification_plans",
    "goal_verifications",
    "verification_gap_reports",
    "gap_remediation_receipts",
    "delivery_reports",
  ]) {
    assert.match(schema, new RegExp(`"${table}"`), table);
    assert.match(migration, new RegExp(`${table}_append_only`), table);
  }
  assert.match(migration, /delivery_reports_verification_plan_fk/);
  assert.match(migration, /delivery_reports_issue_plan_fk/);
  assert.match(migration, /goal_verifications_session_uidx/);
  assert.match(migration, /delivery_reports_status_chk/);
});

test("P10 exposes server routes for plans, verification, gaps, remediation, reports, acceptance, and export", async () => {
  const files = [
    "verification-plans/route.ts",
    "verifications/route.ts",
    "verification-gaps/route.ts",
    "verification-gaps/[reportId]/remediations/route.ts",
    "delivery-reports/route.ts",
    "delivery-reports/[reportId]/acceptances/route.ts",
    "delivery-reports/[reportId]/export/route.ts",
  ];
  for (const file of files) {
    const source = await readFile(new URL(
      `../app/api/v1/goals/[goalId]/${file}`,
      import.meta.url,
    ), "utf8");
    assert.match(source, /getGoalVerificationHandler/);
  }
});

test("P10 Delivery Report source accepts only approved Review evidence for the final Commit", async () => {
  const source = await readFile(new URL(
    "../app/control-plane/adapters/postgres-delivery-report-source.ts",
    import.meta.url,
  ), "utf8");
  assert.match(source, /review\.verdict='approved'/);
  assert.match(source, /review\.target_commit_sha=candidate\.commit_sha/);
});
