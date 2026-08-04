import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import pg from "pg";

import {
  buildAtomicMigrationSql,
  loadPostgresMigrations,
} from "./postgres-migration.ts";

const execFileAsync = promisify(execFile);
const migrationsDirectory = new URL("../drizzle-postgres/", import.meta.url);
const { Pool } = pg;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Temporary PostgreSQL port allocation failed"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startLocalPostgres(): Promise<{
  adminUrl: string;
  dataDirectory: string;
}> {
  const dataDirectory = await mkdtemp(
    join(tmpdir(), "ai-dev-harness-pg-"),
  );
  const port = await freePort();
  await execFileAsync("initdb", [
    "-D",
    dataDirectory,
    "--username=postgres",
    "--auth=trust",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  await execFileAsync("pg_ctl", [
    "-D",
    dataDirectory,
    "-l",
    join(dataDirectory, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port}`,
    "-w",
    "start",
  ]);
  return {
    adminUrl: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    dataDirectory,
  };
}

async function stopLocalPostgres(dataDirectory: string): Promise<void> {
  await execFileAsync("pg_ctl", [
    "-D",
    dataDirectory,
    "-m",
    "fast",
    "-w",
    "stop",
  ]);
  if (
    dirname(dataDirectory) !== tmpdir() ||
    !basename(dataDirectory).startsWith("ai-dev-harness-pg-")
  ) {
    throw new Error("Refusing to remove an unexpected PostgreSQL directory");
  }
  await rm(dataDirectory, { recursive: true, force: true });
}

function databaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function safeIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Temporary PostgreSQL identifier is invalid");
  }
  return `"${value}"`;
}

const defaultIntegrationTestFiles = [
  "tests/postgres-integration.test.mjs",
  "tests/p7-postgres-integration.test.mjs",
  "tests/p8-postgres-integration.test.mjs",
  "tests/p9-postgres-integration.test.mjs",
  "tests/security-regression-postgres.test.mjs",
] as const;

function selectIntegrationTestFiles(arguments_: string[]): string[] {
  if (arguments_.length === 0) return [...defaultIntegrationTestFiles];
  const allowed = new Set<string>(defaultIntegrationTestFiles);
  if (arguments_.some((file) => !allowed.has(file))) {
    throw new Error("Requested PostgreSQL integration test is not allowlisted");
  }
  return [...new Set(arguments_)];
}

async function runIntegrationTest(
  url: string,
  testFiles: string[],
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--test",
        "--test-concurrency=1",
        ...testFiles,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          POSTGRES_INTEGRATION_DATABASE_URL: url,
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error("PostgreSQL integration test was interrupted"));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<number> {
  let phase = "startup";
  const testFiles = selectIntegrationTestFiles(process.argv.slice(2));
  let dataDirectory: string | undefined;
  let adminPool: InstanceType<typeof Pool> | undefined;
  let testPool: InstanceType<typeof Pool> | undefined;
  let databaseName: string | undefined;
  let testUrl: string | undefined;
  let passed = false;
  let cleanupFailed = false;
  try {
    let adminUrl = process.env.POSTGRES_TEST_ADMIN_URL?.trim();
    if (!adminUrl) {
      phase = "local_postgres_start";
      const local = await startLocalPostgres();
      adminUrl = local.adminUrl;
      dataDirectory = local.dataDirectory;
    }
    databaseName = `p1_04_${process.pid}_${Date.now()}`;
    const identifier = safeIdentifier(databaseName);
    phase = "temporary_database_create";
    adminPool = new Pool({ connectionString: adminUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE ${identifier}`);
    testUrl = databaseUrl(adminUrl, databaseName);
    testPool = new Pool({ connectionString: testUrl, max: 2 });
    const before = await testPool.query(
      "SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
    );
    if (Number(before.rows[0]?.count) !== 0) {
      throw new Error("Temporary PostgreSQL database is not empty");
    }
    phase = "schema_migration";
    await testPool.query("CREATE SCHEMA drizzle");
    await testPool.query(`CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);
    const migrations = loadPostgresMigrations(migrationsDirectory);
    await testPool.query(buildAtomicMigrationSql(migrations));

    phase = "integration_tests";
    const status = await runIntegrationTest(testUrl, testFiles);
    if (status !== 0) {
      throw new Error("PostgreSQL integration suite failed");
    }
    const leftovers = await testPool.query(
      `SELECT
         (SELECT count(*)::integer FROM workbench_snapshots WHERE scope_id LIKE 'p1_04_%') AS snapshots,
         (SELECT count(*)::integer FROM workbench_tasks WHERE scope_id LIKE 'p1_04_%') AS tasks`,
    );
    if (
      Number(leftovers.rows[0]?.snapshots) !== 0 ||
      Number(leftovers.rows[0]?.tasks) !== 0
    ) {
      throw new Error("PostgreSQL integration scope cleanup failed");
    }
    passed = true;
    phase = "complete";
  } catch {
    console.error(
      `PostgreSQL integration suite failed at ${phase}; connection details were suppressed`,
    );
  } finally {
    if (testPool) {
      await testPool.end().catch(() => {
        cleanupFailed = true;
      });
    }
    if (adminPool && databaseName) {
      try {
        await adminPool.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseName],
        );
        await adminPool.query(`DROP DATABASE ${safeIdentifier(databaseName)}`);
      } catch {
        cleanupFailed = true;
      }
    }
    if (adminPool) {
      await adminPool.end().catch(() => {
        cleanupFailed = true;
      });
    }
    if (dataDirectory) {
      await stopLocalPostgres(dataDirectory).catch(() => {
        cleanupFailed = true;
      });
    }
    testUrl = undefined;
  }
  if (!passed || cleanupFailed) {
    if (cleanupFailed) {
      console.error(
        "PostgreSQL integration cleanup failed; connection details were suppressed",
      );
    }
    return 1;
  }
  console.log(
    "Temporary PostgreSQL migrate/write/read/error/rollback integration suite passed and was destroyed",
  );
  return 0;
}

process.exitCode = await main();
