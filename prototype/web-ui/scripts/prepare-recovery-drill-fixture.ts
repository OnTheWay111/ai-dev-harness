import pg from "pg";

import {
  buildAtomicMigrationSql,
  loadPostgresMigrations,
} from "./postgres-migration.ts";

const { Pool } = pg;
const migrationsDirectory = new URL("../drizzle-postgres/", import.meta.url);
const SAFE_SOURCE = /^harness_recovery_source_[a-z0-9_]{1,40}$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function identifier(value: string): string {
  if (!SAFE_SOURCE.test(value)) {
    throw new Error("Recovery fixture source database name is unsafe");
  }
  return `"${value}"`;
}

function databaseUrl(adminUrl: string, database: string): string {
  const value = new URL(adminUrl);
  value.pathname = `/${database}`;
  return value.toString();
}

async function main(): Promise<void> {
  const adminUrl = required("RECOVERY_ADMIN_DATABASE_URL");
  const sourceDatabase = required("RECOVERY_SOURCE_DATABASE");
  const quoted = identifier(sourceDatabase);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  let source: InstanceType<typeof Pool> | undefined;
  try {
    const exists = await admin.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS exists",
      [sourceDatabase],
    );
    if (exists.rows[0]?.exists) {
      throw new Error("Recovery fixture source already exists; choose a new drill ID");
    }
    await admin.query(`CREATE DATABASE ${quoted}`);
    source = new Pool({
      connectionString: databaseUrl(adminUrl, sourceDatabase),
      max: 1,
    });
    await source.query("CREATE SCHEMA drizzle");
    await source.query(`CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);
    await source.query(buildAtomicMigrationSql(
      loadPostgresMigrations(migrationsDirectory),
    ));

    const organizationId = "11000000-0000-4000-8000-000000000001";
    const projectId = "11000000-0000-4000-8000-000000000002";
    const goalId = "11000000-0000-4000-8000-000000000003";
    const specId = "11000000-0000-4000-8000-000000000004";
    const issueId = "11000000-0000-4000-8000-000000000005";
    const runId = "11000000-0000-4000-8000-000000000006";
    const auditId = "11000000-0000-4000-8000-000000000007";
    const objectId = "11000000-0000-4000-8000-000000000008";
    const digest = "d".repeat(64);
    const createdAt = new Date("2026-08-05T12:00:00.000Z");
    const retentionUntil = new Date("2027-02-01T12:00:00.000Z");
    await source.query("BEGIN");
    try {
      await source.query(
        `INSERT INTO organizations (id,slug,name,created_at,updated_at)
         VALUES ($1,'p11-recovery-org','P11 recovery organization',$2,$2)`,
        [organizationId, createdAt],
      );
      await source.query(
        `INSERT INTO projects
          (id,organization_id,slug,name,created_at,updated_at)
         VALUES ($1,$2,'p11-recovery-project','P11 recovery project',$3,$3)`,
        [projectId, organizationId, createdAt],
      );
      await source.query(
        `INSERT INTO goals
          (id,organization_id,project_id,title,problem_statement,desired_outcome,
           created_at,updated_at)
         VALUES ($1,$2,$3,'P11 recovery goal','Prove database recovery',
           'Restore authoritative facts',$4,$4)`,
        [goalId, organizationId, projectId, createdAt],
      );
      await source.query(
        `INSERT INTO spec_revisions
          (id,organization_id,project_id,goal_id,revision,status,
           source_goal_version,artifact_ref,artifact_digest,generated_at,
           created_at,updated_at)
         VALUES ($1,$2,$3,$4,1,'approved',1,'artifact://p11/recovery/spec',
           $5,$6,$6,$6)`,
        [specId, organizationId, projectId, goalId, digest, createdAt],
      );
      await source.query(
        `INSERT INTO issues
          (id,organization_id,project_id,goal_id,spec_revision_id,issue_key,
           revision,status,title,body_ref,body_digest,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'P11-RECOVERY',1,'in_progress',
           'Recovery drill issue','artifact://p11/recovery/issue',$6,$7,$7)`,
        [issueId, organizationId, projectId, goalId, specId, digest, createdAt],
      );
      await source.query(
        `INSERT INTO runs
          (id,organization_id,project_id,goal_id,issue_id,attempt,status,
           request_id,started_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,1,'running','p11-recovery-drill',$6,$6,$6)`,
        [runId, organizationId, projectId, goalId, issueId, createdAt],
      );
      await source.query(
        `INSERT INTO audit_events
          (id,organization_id,project_id,goal_id,actor_id,action,entity_type,
           entity_id,entity_version,reason,request_id,retention_until,created_at)
         VALUES ($1,$2,$3,$4,'recovery-operator','recovery.fixture.created',
           'run',$5,1,'Seed isolated P11 recovery drill','p11-recovery-drill',
           $6,$7)`,
        [auditId, organizationId, projectId, goalId, runId, retentionUntil,
          createdAt],
      );
      await source.query(
        `INSERT INTO artifact_objects
          (id,organization_id,project_id,object_key,digest,artifact_kind,
           media_type,size_bytes,created_by_actor_id,retention_policy,
           retention_until,created_at)
         VALUES ($1,$2,$3,$4,$5,'test_output','application/json',128,
           'recovery-worker','standard_180d',$6,$7)`,
        [objectId, organizationId, projectId,
          `${organizationId}/${projectId}/sha256/${digest}`, digest,
          retentionUntil, createdAt],
      );
      await source.query("COMMIT");
    } catch (error) {
      await source.query("ROLLBACK");
      throw error;
    }
    console.log(JSON.stringify({
      schemaVersion: "harness.recovery-fixture.v1",
      sourceDatabase,
      seeded: ["goal", "issue", "run", "audit", "artifact_digest"],
      migrationCount: loadPostgresMigrations(migrationsDirectory).length,
    }));
  } finally {
    await source?.end();
    await admin.end();
  }
}

main().catch(() => {
  console.error("Recovery fixture preparation failed; connection details were suppressed");
  process.exitCode = 1;
});
