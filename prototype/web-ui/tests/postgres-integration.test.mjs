import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import { workbenchSnapshot } from
  "../app/workbench/server/demo-workbench-snapshot.ts";
import {
  NodePostgresWorkbenchProjectionWriter,
  NodePostgresWorkbenchReadStore,
} from "../app/workbench/server/node-postgres-workbench-store.ts";
import { PostgresWorkbenchReadRepository } from
  "../app/workbench/server/postgres-workbench-repository.ts";

const databaseUrl = process.env.POSTGRES_INTEGRATION_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const { Pool } = pg;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;
const scopePrefix = `p1_04_${process.pid}`;

before(async () => {
  if (!pool) return;
  await pool.query(
    "DELETE FROM workbench_tasks WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
  await pool.query(
    "DELETE FROM workbench_snapshots WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
});

after(async () => {
  if (!pool) return;
  await pool.query(
    "DELETE FROM workbench_tasks WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
  await pool.query(
    "DELETE FROM workbench_snapshots WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
  await pool.end();
});

integrationTest("migrates an empty temporary PostgreSQL database", async () => {
  const ledger = await pool.query(
    "SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at",
  );
  assert.deepEqual(ledger.rows, [
    {
      hash: "43239da5baa413cb0475b5285ed5ded7a932f89dc5014eae2ff9fd79e82f92a0",
      created_at: "1785742303861",
    },
  ]);
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    ["workbench_snapshots", "workbench_tasks"],
  );
});

integrationTest(
  "replaces and reads a real projection with consistent revision and filters",
  async () => {
    const scopeId = `${scopePrefix}_projection`;
    const writer = new NodePostgresWorkbenchProjectionWriter(pool);
    const repository = new PostgresWorkbenchReadRepository(
      new NodePostgresWorkbenchReadStore(pool),
      scopeId,
    );
    const snapshot = {
      ...structuredClone(workbenchSnapshot),
      revision: 204,
      generatedAt: "2026-08-04T06:00:00.000Z",
    };
    await writer.replaceProjection(scopeId, snapshot);

    const firstPage = await repository.getWorkbench({ limit: 2 });
    assert.equal(firstPage.data.revision, 204);
    assert.deepEqual(
      firstPage.data.tasks.map((task) => task.id),
      ["DEV-07", "ORD-02"],
    );
    assert.deepEqual(firstPage.page, { nextCursor: "wb1_2", total: 7 });

    const attentionFirst = await repository.getWorkbench({
      filter: "attention",
      limit: 2,
    });
    const attentionSecond = await repository.getWorkbench({
      filter: "attention",
      limit: 2,
      cursor: attentionFirst.page.nextCursor,
    });
    assert.equal(attentionFirst.page.total, 4);
    assert.equal(attentionFirst.data.tasks.length, 2);
    assert.equal(attentionSecond.data.tasks.length, 2);
    assert.ok(
      [...attentionFirst.data.tasks, ...attentionSecond.data.tasks].every(
        (task) => task.attention.required,
      ),
    );

    assert.equal(
      (await repository.getWorkbench({ goalId: "GOAL-2407" })).page.total,
      4,
    );
    assert.equal(
      (await repository.getWorkbench({ filter: "blocked" })).page.total,
      2,
    );
    assert.equal(
      (await repository.getWorkbench({ filter: "running" })).page.total,
      1,
    );
  },
);

integrationTest("fails on empty projection and invalid cursors", async () => {
  const store = new NodePostgresWorkbenchReadStore(pool);
  const empty = new PostgresWorkbenchReadRepository(
    store,
    `${scopePrefix}_empty`,
  );
  await assert.rejects(
    () => empty.getWorkbench(),
    /snapshot is unavailable/i,
  );

  const populated = new PostgresWorkbenchReadRepository(
    store,
    `${scopePrefix}_projection`,
  );
  await assert.rejects(
    () => populated.getWorkbench({ cursor: "invalid" }),
    /cursor/i,
  );
  await assert.rejects(
    () => populated.getWorkbench({ cursor: "wb1_999" }),
    /cursor/i,
  );
});

integrationTest("rolls back a partially failed projection replacement", async () => {
  const scopeId = `${scopePrefix}_rollback`;
  const writer = new NodePostgresWorkbenchProjectionWriter(pool);
  const repository = new PostgresWorkbenchReadRepository(
    new NodePostgresWorkbenchReadStore(pool),
    scopeId,
  );
  await writer.replaceProjection(scopeId, {
    ...structuredClone(workbenchSnapshot),
    revision: 301,
  });

  const invalid = structuredClone(workbenchSnapshot);
  invalid.revision = 302;
  invalid.tasks[0].progress.updatedAt = "not-a-timestamp";
  await assert.rejects(() => writer.replaceProjection(scopeId, invalid));

  const preserved = await repository.getWorkbench();
  assert.equal(preserved.data.revision, 301);
  assert.equal(preserved.data.tasks.length, 7);
  assert.equal(preserved.data.tasks[0].id, "DEV-07");
});

integrationTest("surfaces a real PostgreSQL connection failure", async () => {
  const unavailablePool = new Pool({
    connectionString: "postgresql://postgres@127.0.0.1:1/postgres",
    connectionTimeoutMillis: 200,
  });
  const repository = new PostgresWorkbenchReadRepository(
    new NodePostgresWorkbenchReadStore(unavailablePool),
    "unavailable",
  );
  try {
    await assert.rejects(() => repository.getWorkbench());
  } finally {
    await unavailablePool.end();
  }
});
