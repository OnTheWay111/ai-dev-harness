import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  acceptanceCriteria,
  goals,
  organizations,
  projects,
  repositories,
  repositoryProviders,
} from "../db/postgres-schema.ts";

function columnNames(table) {
  return getTableConfig(table).columns.map((column) => column.name);
}

function constraintNames(table) {
  const config = getTableConfig(table);
  return {
    checks: config.checks.map((value) => value.name).sort(),
    foreignKeys: config.foreignKeys.map((value) => value.getName()).sort(),
    indexes: config.indexes.map((value) => value.config.name).sort(),
    uniques: config.uniqueConstraints
      .map((value) => value.getName())
      .sort(),
  };
}

test("defines only the P2-01 authoritative control-plane tables", () => {
  assert.deepEqual(repositoryProviders, ["github"]);
  assert.deepEqual(
    [organizations, projects, repositories, goals, acceptanceCriteria].map(
      (table) => getTableConfig(table).name,
    ),
    [
      "organizations",
      "projects",
      "repositories",
      "goals",
      "acceptance_criteria",
    ],
  );
  assert.deepEqual(columnNames(organizations), [
    "id",
    "slug",
    "name",
    "version",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(columnNames(projects), [
    "id",
    "organization_id",
    "slug",
    "name",
    "version",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(columnNames(repositories), [
    "id",
    "organization_id",
    "project_id",
    "provider",
    "provider_repository_id",
    "owner",
    "name",
    "default_branch",
    "version",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(columnNames(goals), [
    "id",
    "organization_id",
    "project_id",
    "title",
    "problem_statement",
    "desired_outcome",
    "version",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(columnNames(acceptanceCriteria), [
    "id",
    "organization_id",
    "project_id",
    "goal_id",
    "position",
    "statement",
    "version",
    "created_at",
    "updated_at",
  ]);
});

test("enforces the Organization hierarchy through composite foreign keys", () => {
  assert.deepEqual(constraintNames(projects).foreignKeys, [
    "projects_organization_fk",
  ]);
  assert.deepEqual(constraintNames(repositories).foreignKeys, [
    "repositories_project_organization_fk",
  ]);
  assert.deepEqual(constraintNames(goals).foreignKeys, [
    "goals_project_organization_fk",
  ]);
  assert.deepEqual(constraintNames(acceptanceCriteria).foreignKeys, [
    "acceptance_criteria_goal_organization_fk",
  ]);

  for (const table of [projects, repositories, goals, acceptanceCriteria]) {
    assert.ok(columnNames(table).includes("organization_id"));
  }
  for (const table of [repositories, goals, acceptanceCriteria]) {
    assert.ok(columnNames(table).includes("project_id"));
  }
});

test("adds optimistic versions, timestamps, and scoped uniqueness", () => {
  for (const table of [
    organizations,
    projects,
    repositories,
    goals,
    acceptanceCriteria,
  ]) {
    const config = getTableConfig(table);
    const version = config.columns.find((column) => column.name === "version");
    const createdAt = config.columns.find(
      (column) => column.name === "created_at",
    );
    const updatedAt = config.columns.find(
      (column) => column.name === "updated_at",
    );
    assert.equal(version?.notNull, true);
    assert.equal(version?.default, 1);
    assert.equal(createdAt?.notNull, true);
    assert.ok(createdAt?.default);
    assert.equal(updatedAt?.notNull, true);
    assert.ok(updatedAt?.default);
    assert.ok(
      constraintNames(table).checks.some((name) =>
        name.endsWith("_version_positive_chk")
      ),
    );
    assert.ok(
      constraintNames(table).checks.some((name) =>
        name.endsWith("_timestamps_order_chk")
      ),
    );
  }

  assert.ok(
    constraintNames(projects).uniques.includes(
      "projects_organization_id_id_uidx",
    ),
  );
  assert.ok(
    constraintNames(goals).uniques.includes(
      "goals_organization_project_id_uidx",
    ),
  );
  assert.ok(
    constraintNames(acceptanceCriteria).indexes.includes(
      "acceptance_criteria_goal_position_uidx",
    ),
  );
});
