import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { PostgresRoleBindingRepository } from
  "../app/auth/postgres-role-binding-repository.ts";
import { RoleBindingReleaseCenterAuthorizer } from
  "../app/release-center/authorizer.ts";
import { finalizeCanary } from "../app/release-center/domain.ts";
import { PostgresReleaseCenterRepository } from
  "../app/release-center/postgres-repository.ts";
import { ReleaseCenterService } from "../app/release-center/service.ts";

const { Pool } = pg;
const HOUR = 60 * 60 * 1_000;
const START = new Date("2026-08-05T00:00:00.000Z");

function command(actorId, key, reason = `Authorized P12 release command ${key}`) {
  return {
    actorId,
    requestId: `request-${key}`,
    idempotencyKey: `idempotency-${key}`,
    reason,
  };
}

test("PostgreSQL persists the complete Canary, ten-gate, and one-owner release", {
  skip: !process.env.POSTGRES_INTEGRATION_DATABASE_URL,
}, async () => {
  const pool = new Pool({
    connectionString: process.env.POSTGRES_INTEGRATION_DATABASE_URL,
    max: 4,
  });
  const scope = {
    organizationId: randomUUID(),
    projectId: randomUUID(),
  };
  const goalId = randomUUID();
  const owner = "oidc_release_owner";
  let now = START;
  try {
    await pool.query(
      `INSERT INTO organizations (id,slug,name,created_at,updated_at)
       VALUES ($1,$2,'P12 Release Center integration',$3,$3)`,
      [scope.organizationId, `release-${scope.organizationId.slice(0, 8)}`, START],
    );
    await pool.query(
      `INSERT INTO projects (id,organization_id,slug,name,created_at,updated_at)
       VALUES ($1,$2,$3,'P12 Release Center project',$4,$4)`,
      [scope.projectId, scope.organizationId, `release-${scope.projectId.slice(0, 8)}`, START],
    );
    await pool.query(
      `INSERT INTO goals
         (id,organization_id,project_id,title,problem_statement,desired_outcome,
          status,created_at,updated_at)
       VALUES ($1,$2,$3,'P12 release candidate','Prove durable release gates',
               'Approve only digest-bound evidence','completed',$4,$4)`,
      [goalId, scope.organizationId, scope.projectId, START],
    );
    const bindings = [[owner, "organization_owner", null]];
    for (const [actorId, role, projectId] of bindings) {
      await pool.query(
        `INSERT INTO role_bindings
           (id,organization_id,project_id,actor_id,role,assigned_by_actor_id,
            reason,request_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'p12-bootstrap',
                 'Authorize isolated P12 integration role','p12-bootstrap',$6,$6)`,
        [randomUUID(), scope.organizationId, projectId, actorId, role, START],
      );
    }

    const repository = new PostgresReleaseCenterRepository(pool);
    const service = new ReleaseCenterService({
      repository,
      authorizer: new RoleBindingReleaseCenterAuthorizer(
        new PostgresRoleBindingRepository(pool),
      ),
      clock: () => now,
      idGenerator: randomUUID,
    });
    let canary = await service.createCanary({
      ...scope,
      goalId,
      candidateCommit: "a".repeat(40),
      goalContractVersion: 7,
      allowedAreas: ["documentation"],
      excludedAreas: ["production-data"],
      successConditions: ["Goal Verification passed", "No P0/P1 for 12 hours"],
      stopConditions: ["Any P0/P1", "owner requests Stop"],
      rollbackRunbook: "docs/runbooks/deployment-rollback-upgrade.md",
      stopRunbook: "docs/runbooks/execution-stop-worker-loss.md",
      ...command(owner, "create"),
    });
    canary = await service.approveCanary({
      ...scope,
      canaryId: canary.id,
      expectedVersion: canary.version,
      ...command(owner, "approve"),
    });
    for (let index = 0; index < 12; index += 1) {
      now = new Date(START.getTime() + (index + 1) * HOUR);
      canary = await service.recordCanaryWindow({
        ...scope,
        canaryId: canary.id,
        expectedVersion: canary.version,
        window: {
          sequence: index + 1,
          startedAt: new Date(START.getTime() + index * HOUR).toISOString(),
          endedAt: now.toISOString(),
          status: "healthy",
          p0Count: 0,
          p1Count: 0,
          evidenceRefs: [`metric-window:${index + 1}`],
        },
        ...command(owner, `window-${index + 1}`),
      });
    }
    now = new Date(START.getTime() + 13 * HOUR);
    const verificationId = randomUUID();
    const passed = finalizeCanary(canary, {
      verification: {
        id: verificationId,
        verdict: "passed",
        verifiedAt: new Date(START.getTime() + 11 * HOUR).toISOString(),
        evidenceRefs: [`goal-verification:${verificationId}`],
      },
      now,
    });
    canary = await repository.commitCanary({
      aggregate: passed,
      expectedVersion: canary.version,
      command: {
        ...scope,
        ...command(owner, "finalize-fixture"),
        requestHash: "c".repeat(64),
        endpoint: "release.canary.finalize",
        auditId: randomUUID(),
        eventId: randomUUID(),
        eventType: "release.canary.passed",
        occurredAt: now.toISOString(),
      },
    });
    assert.equal(canary.status, "passed");

    let release = await service.createProductionRelease({
      ...scope,
      canaryId: canary.id,
      ...command(owner, "create-release"),
    });
    const gateIds = [
      "browser-e2e", "identity-security", "autodev-authorization",
      "model-routing-write", "supply-chain", "git-traceability",
      "recovery-stop", "observability-oncall", "canary-goal-verification",
      "defect-budget",
    ];
    for (const [index, gateId] of gateIds.entries()) {
      now = new Date(START.getTime() + 13 * HOUR + (index + 1) * 1_000);
      release = await service.recordProductionGate({
        ...scope,
        releaseId: release.id,
        expectedVersion: release.version,
        gateId,
        ownerRole: "owner",
        evidenceRefs: [`gate-receipt:${gateId}`],
        ...command(owner, `gate-${index + 1}`),
      });
    }
    now = new Date(START.getTime() + 14 * HOUR);
    release = await service.evaluateProductionRelease({
      ...scope,
      releaseId: release.id,
      expectedVersion: release.version,
      ...command(owner, "evaluate"),
    });
    now = new Date(START.getTime() + 14 * HOUR + 1_000);
    release = await service.signProductionRelease({
      ...scope,
      releaseId: release.id,
      expectedVersion: release.version,
      role: "owner",
      ...command(
        owner,
        "sign-owner",
        "The owner approved all Production V1 release evidence.",
      ),
    });
    assert.equal(release.status, "approved");
    const replay = await service.signProductionRelease({
      ...scope,
      releaseId: release.id,
      expectedVersion: release.version - 1,
      role: "owner",
      ...command(
        owner,
        "sign-owner",
        "The owner approved all Production V1 release evidence.",
      ),
    });
    assert.equal(replay.signatures.length, 1);

    const proof = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM release_canaries WHERE id=$1) AS canaries,
        (SELECT count(*)::int FROM release_canary_windows WHERE canary_id=$1) AS windows,
        (SELECT count(*)::int FROM production_releases WHERE id=$2 AND status='approved') AS releases,
        (SELECT count(*)::int FROM production_gate_checks WHERE release_id=$2) AS gates,
        (SELECT count(*)::int FROM production_release_signatures WHERE release_id=$2) AS signatures,
        (SELECT count(*)::int FROM audit_events WHERE entity_id IN ($1,$2)) AS audits,
        (SELECT count(*)::int FROM outbox_events WHERE aggregate_id IN ($1,$2)) AS outbox`,
      [canary.id, release.id],
    );
    assert.deepEqual(proof.rows[0], {
      canaries: 1,
      windows: 12,
      releases: 1,
      gates: 10,
      signatures: 1,
      audits: 28,
      outbox: 28,
    });
    await assert.rejects(
      pool.query(
        "UPDATE release_canary_windows SET status='unhealthy' WHERE canary_id=$1",
        [canary.id],
      ),
      /append-only/,
    );
    await assert.rejects(
      pool.query(
        "DELETE FROM production_release_signatures WHERE release_id=$1",
        [release.id],
      ),
      /append-only/,
    );
    await assert.rejects(
      pool.query(
        "UPDATE production_gate_checks SET evidence_refs='[\"gate-receipt:tampered\"]'::jsonb WHERE release_id=$1",
        [release.id],
      ),
      /evidence is locked/,
    );
  } finally {
    await pool.end();
  }
});
