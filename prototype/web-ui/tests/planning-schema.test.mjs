import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  clarificationStatuses,
  clarifications,
  decisionStatuses,
  decisions,
  issueDependencies,
  issueStatuses,
  issues,
  specRevisionStatuses,
  specRevisions,
} from "../db/postgres-schema.ts";
import {
  serializePlanningRecord,
  toIssueDependencyEdges,
} from "../app/control-plane/domain/planning-model.ts";

function names(table) {
  const config = getTableConfig(table);
  return {
    columns: config.columns.map((column) => column.name),
    checks: config.checks.map((check) => check.name).sort(),
    foreignKeys: config.foreignKeys.map((key) => key.getName()).sort(),
    indexes: config.indexes.map((index) => index.config.name).sort(),
    uniques: config.uniqueConstraints.map((unique) => unique.name).sort(),
  };
}

test("defines the P2-02 planning states as stable serialized values", () => {
  assert.deepEqual(clarificationStatuses, ["open", "answered", "superseded"]);
  assert.deepEqual(decisionStatuses, [
    "proposed",
    "approved",
    "rejected",
    "superseded",
  ]);
  assert.deepEqual(specRevisionStatuses, [
    "draft",
    "in_review",
    "approved",
    "rejected",
    "superseded",
  ]);
  assert.deepEqual(issueStatuses, [
    "draft",
    "approved",
    "ready",
    "in_progress",
    "blocked",
    "completed",
    "cancelled",
  ]);
});

test("defines immutable clarification and decision revision chains", () => {
  assert.deepEqual(names(clarifications).columns, [
    "id",
    "organization_id",
    "project_id",
    "goal_id",
    "thread_id",
    "revision",
    "previous_clarification_id",
    "status",
    "question",
    "answer",
    "source_goal_version",
    "created_at",
  ]);
  assert.deepEqual(names(decisions).columns, [
    "id",
    "organization_id",
    "project_id",
    "goal_id",
    "decision_key",
    "revision",
    "previous_decision_id",
    "status",
    "subject_type",
    "subject_id",
    "subject_version",
    "outcome",
    "reason",
    "created_at",
  ]);
  assert.deepEqual(names(clarifications).foreignKeys, [
    "clarifications_goal_organization_fk",
    "clarifications_previous_revision_fk",
  ]);
  assert.deepEqual(names(decisions).foreignKeys, [
    "decisions_goal_organization_fk",
    "decisions_previous_revision_fk",
  ]);
  assert.ok(
    names(clarifications).indexes.includes(
      "clarifications_goal_thread_revision_uidx",
    ),
  );
  assert.ok(
    names(decisions).indexes.includes("decisions_goal_key_revision_uidx"),
  );
});

test("binds SpecRevision, Issue, and dependencies to one Goal boundary", () => {
  assert.deepEqual(names(specRevisions).foreignKeys, [
    "spec_revisions_goal_organization_fk",
    "spec_revisions_previous_revision_fk",
  ]);
  assert.deepEqual(names(issues).foreignKeys, [
    "issues_previous_revision_fk",
    "issues_spec_revision_goal_fk",
  ]);
  assert.deepEqual(names(issueDependencies).foreignKeys, [
    "issue_dependencies_depends_on_goal_fk",
    "issue_dependencies_issue_goal_fk",
  ]);
  assert.ok(names(issueDependencies).checks.includes(
    "issue_dependencies_not_self_chk",
  ));
  assert.ok(names(issues).indexes.includes("issues_goal_key_revision_uidx"));
  assert.ok(names(specRevisions).indexes.includes(
    "spec_revisions_goal_revision_uidx",
  ));
});

test("serializes planning records without Date or ORM representation leakage", () => {
  const record = serializePlanningRecord({
    kind: "issue",
    id: "00000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-8000-000000000002",
    projectId: "00000000-0000-4000-8000-000000000003",
    goalId: "00000000-0000-4000-8000-000000000004",
    issueKey: "P2-02",
    revision: 1,
    status: "draft",
    version: 1,
    createdAt: new Date("2026-08-04T08:00:00.000Z"),
    updatedAt: new Date("2026-08-04T08:00:00.000Z"),
  });
  assert.deepEqual(JSON.parse(record), {
    kind: "issue",
    id: "00000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-8000-000000000002",
    projectId: "00000000-0000-4000-8000-000000000003",
    goalId: "00000000-0000-4000-8000-000000000004",
    issueKey: "P2-02",
    revision: 1,
    status: "draft",
    version: 1,
    createdAt: "2026-08-04T08:00:00.000Z",
    updatedAt: "2026-08-04T08:00:00.000Z",
  });
});

test("exposes dependency edges for deterministic DAG validation", () => {
  assert.deepEqual(
    toIssueDependencyEdges([
      {
        issueId: "00000000-0000-4000-8000-000000000001",
        dependsOnIssueId: "00000000-0000-4000-8000-000000000002",
      },
    ]),
    [
      {
        from: "00000000-0000-4000-8000-000000000002",
        to: "00000000-0000-4000-8000-000000000001",
      },
    ],
  );
});
