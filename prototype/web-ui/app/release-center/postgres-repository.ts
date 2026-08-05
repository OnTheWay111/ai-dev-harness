import { createHash } from "node:crypto";

import type {
  CanaryAggregate,
  CanaryEvent,
  CanaryReport,
  CanaryWindow,
  PassedGoalVerification,
  ProductionGateCheck,
  ProductionReleaseAggregate,
  ProductionReleaseReport,
  ProductionSignature,
} from "./domain.ts";
import {
  type CanaryCommit,
  ReleaseCenterIdempotencyConflictError,
  ReleaseCenterNotFoundError,
  type ReleaseCenterRepository,
  type ReleaseCenterScope,
  type ReleaseCommandMetadata,
  ReleaseCenterVersionConflictError,
  type ProductionReleaseCommit,
} from "./repository.ts";

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface SqlExecutor {
  query<Row extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

interface TransactionClient extends SqlExecutor { release(): void }
export interface ReleaseCenterPool extends SqlExecutor {
  connect(): Promise<TransactionClient>;
}

interface CanaryRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  candidate_commit: string;
  status: CanaryAggregate["status"];
  attempt: number;
  goal_contract_version: number;
  allowed_areas: string[];
  excluded_areas: string[];
  success_conditions: string[];
  stop_conditions: string[];
  rollback_runbook: string;
  stop_runbook: string;
  owner_id: string | null;
  approved_at: Date | string | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  report: CanaryReport | null;
  version: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WindowRow {
  canary_id: string;
  attempt: number;
  sequence: number;
  started_at: Date | string;
  ended_at: Date | string;
  status: CanaryWindow["status"];
  p0_count: number;
  p1_count: number;
  evidence_refs: string[];
  recorded_by: string;
}

interface CanaryEventRow {
  canary_id: string;
  payload: CanaryEvent;
}

interface ReleaseRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  canary_id: string;
  candidate_commit: string;
  status: ProductionReleaseAggregate["status"];
  canary_report: CanaryReport;
  defects: ProductionReleaseReport["defects"];
  evaluated_at: Date | string | null;
  attestation_digest: string | null;
  report: ProductionReleaseReport | null;
  version: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface GateRow {
  release_id: string;
  gate_id: ProductionGateCheck["gateId"];
  status: "passed";
  owner_role: ProductionGateCheck["ownerRole"];
  checked_at: Date | string;
  evidence_refs: string[];
  checked_by: string;
}

interface SignatureRow {
  release_id: string;
  role: ProductionSignature["role"];
  signer_id: string;
  signed_at: Date | string;
  decision: "approved";
  reason: string;
  authentication_method: "oidc";
  request_id: string;
  audit_receipt_id: string;
  attestation_digest: string;
}

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed" | "failed";
  payload: { aggregate?: unknown } | null;
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function json<T>(value: T): T {
  return structuredClone(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapCanary(
  row: CanaryRow,
  windows: readonly WindowRow[],
  events: readonly CanaryEventRow[],
): CanaryAggregate {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    candidateCommit: row.candidate_commit,
    status: row.status,
    attempt: row.attempt,
    goalContractVersion: row.goal_contract_version,
    allowedAreas: json(row.allowed_areas),
    excludedAreas: json(row.excluded_areas),
    successConditions: json(row.success_conditions),
    stopConditions: json(row.stop_conditions),
    rollbackRunbook: row.rollback_runbook,
    stopRunbook: row.stop_runbook,
    ownerId: row.owner_id,
    approvedAt: timestamp(row.approved_at),
    startedAt: timestamp(row.started_at),
    endedAt: timestamp(row.ended_at),
    report: row.report ? json(row.report) : null,
    windows: windows
      .filter(({ canary_id }) => canary_id === row.id)
      .map((window) => ({
        attempt: window.attempt,
        sequence: window.sequence,
        startedAt: timestamp(window.started_at) as string,
        endedAt: timestamp(window.ended_at) as string,
        status: window.status,
        p0Count: window.p0_count,
        p1Count: window.p1_count,
        evidenceRefs: json(window.evidence_refs),
        recordedBy: window.recorded_by,
      })),
    events: events
      .filter(({ canary_id }) => canary_id === row.id)
      .map(({ payload }) => json(payload)),
    version: row.version,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at) as string,
    updatedAt: timestamp(row.updated_at) as string,
  };
}

function mapRelease(
  row: ReleaseRow,
  gates: readonly GateRow[],
  signatures: readonly SignatureRow[],
): ProductionReleaseAggregate {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    canaryId: row.canary_id,
    candidateCommit: row.candidate_commit,
    status: row.status,
    canaryReport: json(row.canary_report),
    gates: gates
      .filter(({ release_id }) => release_id === row.id)
      .map((gate) => ({
        gateId: gate.gate_id,
        status: gate.status,
        ownerRole: gate.owner_role,
        checkedAt: timestamp(gate.checked_at) as string,
        evidenceRefs: json(gate.evidence_refs),
        checkedBy: gate.checked_by,
      })),
    defects: json(row.defects),
    evaluatedAt: timestamp(row.evaluated_at),
    attestationDigest: row.attestation_digest,
    signatures: signatures
      .filter(({ release_id }) => release_id === row.id)
      .map((signature) => ({
        role: signature.role,
        signerId: signature.signer_id,
        signedAt: timestamp(signature.signed_at) as string,
        decision: signature.decision,
        reason: signature.reason,
        authenticationMethod: signature.authentication_method,
        requestId: signature.request_id,
        auditReceiptId: signature.audit_receipt_id,
        attestationDigest: signature.attestation_digest,
      })),
    report: row.report ? json(row.report) : null,
    version: row.version,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at) as string,
    updatedAt: timestamp(row.updated_at) as string,
  };
}

async function loadCanaries(
  executor: SqlExecutor,
  scope: ReleaseCenterScope,
  canaryId?: string,
): Promise<CanaryAggregate[]> {
  const result = await executor.query<CanaryRow>(
    `SELECT id,organization_id,project_id,goal_id,candidate_commit,status,
            attempt,goal_contract_version,allowed_areas,excluded_areas,
            success_conditions,stop_conditions,rollback_runbook,stop_runbook,
            owner_id,approved_at,started_at,ended_at,report,version,created_by,
            created_at,updated_at
       FROM release_canaries
      WHERE organization_id=$1 AND project_id=$2
        AND ($3::uuid IS NULL OR id=$3)
      ORDER BY created_at DESC,id DESC
      LIMIT 50`,
    [scope.organizationId, scope.projectId, canaryId ?? null],
  );
  const ids = result.rows.map(({ id }) => id);
  if (ids.length === 0) return [];
  const [windows, events] = await Promise.all([
    executor.query<WindowRow>(
      `SELECT canary_id,attempt,sequence,started_at,ended_at,status,
              p0_count,p1_count,evidence_refs,recorded_by
         FROM release_canary_windows
        WHERE canary_id=ANY($1::uuid[])
        ORDER BY canary_id,attempt,sequence`,
      [ids],
    ),
    executor.query<CanaryEventRow>(
      `SELECT canary_id,payload
         FROM release_canary_events
        WHERE canary_id=ANY($1::uuid[])
        ORDER BY canary_id,attempt,observed_at,event_key`,
      [ids],
    ),
  ]);
  return result.rows.map((row) => mapCanary(row, windows.rows, events.rows));
}

async function loadReleases(
  executor: SqlExecutor,
  scope: ReleaseCenterScope,
  releaseId?: string,
): Promise<ProductionReleaseAggregate[]> {
  const result = await executor.query<ReleaseRow>(
    `SELECT id,organization_id,project_id,goal_id,canary_id,candidate_commit,
            status,canary_report,defects,evaluated_at,attestation_digest,report,
            version,created_by,created_at,updated_at
       FROM production_releases
      WHERE organization_id=$1 AND project_id=$2
        AND ($3::uuid IS NULL OR id=$3)
      ORDER BY created_at DESC,id DESC
      LIMIT 50`,
    [scope.organizationId, scope.projectId, releaseId ?? null],
  );
  const ids = result.rows.map(({ id }) => id);
  if (ids.length === 0) return [];
  const [gates, signatures] = await Promise.all([
    executor.query<GateRow>(
      `SELECT release_id,gate_id,status,owner_role,checked_at,evidence_refs,
              checked_by
         FROM production_gate_checks
        WHERE release_id=ANY($1::uuid[])
        ORDER BY release_id,gate_id`,
      [ids],
    ),
    executor.query<SignatureRow>(
      `SELECT release_id,role,signer_id,signed_at,decision,reason,
              authentication_method,request_id,audit_receipt_id,
              attestation_digest
         FROM production_release_signatures
        WHERE release_id=ANY($1::uuid[])
        ORDER BY release_id,signed_at,role`,
      [ids],
    ),
  ]);
  return result.rows.map((row) => mapRelease(row, gates.rows, signatures.rows));
}

async function findReplay<T>(
  executor: SqlExecutor,
  command: ReleaseCommandMetadata,
): Promise<T | null> {
  const result = await executor.query<IdempotencyRow>(
    `SELECT ir.request_hash,ir.status,oe.payload
       FROM idempotency_records ir
       LEFT JOIN outbox_events oe ON oe.id::text=ir.response_ref
      WHERE ir.organization_id=$1 AND ir.actor_id=$2
        AND ir.endpoint=$3 AND ir.key=$4`,
    [
      command.organizationId,
      command.actorId,
      command.endpoint,
      command.idempotencyKey,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== command.requestHash) {
    throw new ReleaseCenterIdempotencyConflictError();
  }
  if (row.status !== "completed" || !row.payload?.aggregate) {
    throw new ReleaseCenterIdempotencyConflictError();
  }
  return json(row.payload.aggregate) as T;
}

async function claim(
  executor: SqlExecutor,
  command: ReleaseCommandMetadata,
): Promise<boolean> {
  const result = await executor.query<{ id: string }>(
    `INSERT INTO idempotency_records
       (organization_id,actor_id,endpoint,key,request_hash,expires_at,
        created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz + interval '7 days',$6,$6)
     ON CONFLICT (organization_id,actor_id,endpoint,key) DO NOTHING
     RETURNING id`,
    [
      command.organizationId,
      command.actorId,
      command.endpoint,
      command.idempotencyKey,
      command.requestHash,
      command.occurredAt,
    ],
  );
  return result.rowCount === 1;
}

async function insertAudit(
  executor: SqlExecutor,
  command: ReleaseCommandMetadata,
  entityType: "release_canary" | "production_release",
  entityId: string,
  entityVersion: number,
) {
  const createdAt = new Date(command.occurredAt);
  await executor.query(
    `INSERT INTO audit_events
       (id,organization_id,project_id,actor_id,action,entity_type,entity_id,
        entity_version,reason,request_id,policy_revision,retention_until,
        created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'p12-release-policy.v1',
             $11,$12)`,
    [
      command.auditId,
      command.organizationId,
      command.projectId,
      command.actorId,
      command.eventType,
      entityType,
      entityId,
      entityVersion,
      command.reason,
      command.requestId,
      new Date(createdAt.getTime() + 365 * 24 * 60 * 60 * 1_000),
      createdAt,
    ],
  );
}

async function complete(
  executor: SqlExecutor,
  command: ReleaseCommandMetadata,
  aggregateType: "release_canary" | "production_release",
  aggregate: CanaryAggregate | ProductionReleaseAggregate,
) {
  const responseDigest = digest(aggregate);
  await executor.query(
    `INSERT INTO outbox_events
       (id,organization_id,aggregate_type,aggregate_id,aggregate_version,
        event_type,deduplication_key,payload,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9)`,
    [
      command.eventId,
      command.organizationId,
      aggregateType,
      aggregate.id,
      aggregate.version,
      command.eventType,
      command.eventId,
      JSON.stringify({ aggregate }),
      new Date(command.occurredAt),
    ],
  );
  const updated = await executor.query(
    `UPDATE idempotency_records
        SET status='completed',response_status=200,response_ref=$1,
            response_digest=$2,updated_at=$3
      WHERE organization_id=$4 AND actor_id=$5 AND endpoint=$6 AND key=$7
        AND status='in_progress'`,
    [
      command.eventId,
      responseDigest,
      new Date(command.occurredAt),
      command.organizationId,
      command.actorId,
      command.endpoint,
      command.idempotencyKey,
    ],
  );
  if (updated.rowCount !== 1) throw new ReleaseCenterIdempotencyConflictError();
}

function databaseError(error: unknown): never {
  const code = error && typeof error === "object"
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (code === "23503") throw new ReleaseCenterNotFoundError();
  if (code === "23505" || code === "23514") {
    throw new ReleaseCenterVersionConflictError();
  }
  throw error;
}

export class PostgresReleaseCenterRepository implements ReleaseCenterRepository {
  private readonly pool: ReleaseCenterPool;

  constructor(pool: ReleaseCenterPool) {
    this.pool = pool;
  }

  async findCanaryCommand(command: ReleaseCommandMetadata) {
    return await findReplay<CanaryAggregate>(this.pool, command);
  }

  async listCanaries(scope: ReleaseCenterScope) {
    return await loadCanaries(this.pool, scope);
  }

  async getCanary(scope: ReleaseCenterScope & { canaryId: string }) {
    return (await loadCanaries(this.pool, scope, scope.canaryId))[0] ?? null;
  }

  async commitCanary(input: CanaryCommit): Promise<CanaryAggregate> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!await claim(client, input.command)) {
        const replay = await findReplay<CanaryAggregate>(client, input.command);
        if (!replay) throw new ReleaseCenterIdempotencyConflictError();
        await client.query("COMMIT");
        return replay;
      }
      const value = input.aggregate;
      if (input.expectedVersion === 0) {
        await client.query(
          `INSERT INTO release_canaries
             (id,organization_id,project_id,goal_id,candidate_commit,status,
              attempt,goal_contract_version,allowed_areas,excluded_areas,
              success_conditions,stop_conditions,rollback_runbook,stop_runbook,
              owner_id,approved_at,started_at,ended_at,report,version,created_by,
              created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,
                   $12::jsonb,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23)`,
          [
            value.id, value.organizationId, value.projectId, value.goalId,
            value.candidateCommit, value.status, value.attempt,
            value.goalContractVersion, JSON.stringify(value.allowedAreas),
            JSON.stringify(value.excludedAreas),
            JSON.stringify(value.successConditions),
            JSON.stringify(value.stopConditions), value.rollbackRunbook,
            value.stopRunbook, value.ownerId, value.approvedAt, value.startedAt,
            value.endedAt, value.report ? JSON.stringify(value.report) : null,
            value.version,
            value.createdBy, value.createdAt, value.updatedAt,
          ],
        );
      } else {
        const updated = await client.query(
          `UPDATE release_canaries
              SET status=$1,attempt=$2,owner_id=$3,approved_at=$4,started_at=$5,
                  ended_at=$6,report=$7::jsonb,version=$8,updated_at=$9
            WHERE id=$10 AND organization_id=$11 AND project_id=$12
              AND version=$13`,
          [
            value.status, value.attempt, value.ownerId, value.approvedAt,
            value.startedAt, value.endedAt,
            value.report ? JSON.stringify(value.report) : null,
            value.version, value.updatedAt, value.id, value.organizationId,
            value.projectId, input.expectedVersion,
          ],
        );
        if (updated.rowCount !== 1) throw new ReleaseCenterVersionConflictError();
      }
      if (input.appendWindow) {
        const window = input.appendWindow;
        await client.query(
          `INSERT INTO release_canary_windows
             (organization_id,project_id,goal_id,canary_id,attempt,sequence,
              started_at,ended_at,status,p0_count,p1_count,evidence_refs,
              recorded_by,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
          [
            value.organizationId, value.projectId, value.goalId, value.id,
            window.attempt, window.sequence, window.startedAt, window.endedAt,
            window.status, window.p0Count, window.p1Count,
            JSON.stringify(window.evidenceRefs), window.recordedBy,
            input.command.occurredAt,
          ],
        );
      }
      if (input.appendEvent) {
        const event = input.appendEvent;
        await client.query(
          `INSERT INTO release_canary_events
             (organization_id,project_id,goal_id,canary_id,attempt,event_key,
              kind,severity,observed_at,payload,recorded_by,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12)`,
          [
            value.organizationId, value.projectId, value.goalId, value.id,
            event.attempt, event.id, event.kind,
            event.kind === "intervention" ? null : event.severity,
            event.observedAt, JSON.stringify(event), event.recordedBy,
            input.command.occurredAt,
          ],
        );
      }
      if (input.resolvedEventId) {
        const event = value.events.find((candidate) =>
          candidate.attempt === value.attempt && candidate.id === input.resolvedEventId
        );
        if (!event) throw new ReleaseCenterNotFoundError();
        const updated = await client.query(
          `UPDATE release_canary_events
              SET payload=$1::jsonb,updated_at=$2
            WHERE canary_id=$3 AND attempt=$4 AND event_key=$5 AND kind='alert'`,
          [
            JSON.stringify(event), input.command.occurredAt, value.id,
            value.attempt, input.resolvedEventId,
          ],
        );
        if (updated.rowCount !== 1) throw new ReleaseCenterNotFoundError();
      }
      await insertAudit(client, input.command, "release_canary", value.id, value.version);
      await complete(client, input.command, "release_canary", value);
      await client.query("COMMIT");
      return json(value);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      databaseError(error);
    } finally {
      client.release();
    }
  }

  async findPassedGoalVerification(input: ReleaseCenterScope & {
    goalId: string;
    startedAt: string;
    endedAt: string;
  }): Promise<PassedGoalVerification | null> {
    const result = await this.pool.query<{
      id: string;
      verified_at: Date | string;
    }>(
      `SELECT id,verified_at
         FROM goal_verifications
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
          AND verdict='passed' AND verified_at >= $4 AND verified_at <= $5
        ORDER BY verified_at DESC,id DESC
        LIMIT 1`,
      [
        input.organizationId, input.projectId, input.goalId,
        input.startedAt, input.endedAt,
      ],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      verdict: "passed",
      verifiedAt: timestamp(row.verified_at) as string,
      evidenceRefs: [`goal-verification:${row.id}`],
    } : null;
  }

  async findProductionReleaseCommand(command: ReleaseCommandMetadata) {
    return await findReplay<ProductionReleaseAggregate>(this.pool, command);
  }

  async listProductionReleases(scope: ReleaseCenterScope) {
    return await loadReleases(this.pool, scope);
  }

  async getProductionRelease(scope: ReleaseCenterScope & { releaseId: string }) {
    return (await loadReleases(this.pool, scope, scope.releaseId))[0] ?? null;
  }

  async commitProductionRelease(
    input: ProductionReleaseCommit,
  ): Promise<ProductionReleaseAggregate> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!await claim(client, input.command)) {
        const replay = await findReplay<ProductionReleaseAggregate>(client, input.command);
        if (!replay) throw new ReleaseCenterIdempotencyConflictError();
        await client.query("COMMIT");
        return replay;
      }
      const value = input.aggregate;
      if (input.expectedVersion === 0) {
        await client.query(
          `INSERT INTO production_releases
             (id,organization_id,project_id,goal_id,canary_id,candidate_commit,
              status,canary_report,defects,evaluated_at,attestation_digest,
              report,version,created_by,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,
                   $12::jsonb,$13,$14,$15,$16)`,
          [
            value.id, value.organizationId, value.projectId, value.goalId,
            value.canaryId, value.candidateCommit, value.status,
            JSON.stringify(value.canaryReport), JSON.stringify(value.defects),
            value.evaluatedAt, value.attestationDigest,
            value.report ? JSON.stringify(value.report) : null,
            value.version, value.createdBy,
            value.createdAt, value.updatedAt,
          ],
        );
      } else {
        const updated = await client.query(
          `UPDATE production_releases
              SET status=$1,evaluated_at=$2,attestation_digest=$3,
                  report=$4::jsonb,version=$5,updated_at=$6
            WHERE id=$7 AND organization_id=$8 AND project_id=$9
              AND version=$10`,
          [
            value.status, value.evaluatedAt, value.attestationDigest,
            value.report ? JSON.stringify(value.report) : null,
            value.version, value.updatedAt,
            value.id, value.organizationId, value.projectId,
            input.expectedVersion,
          ],
        );
        if (updated.rowCount !== 1) throw new ReleaseCenterVersionConflictError();
      }
      if (input.gate) {
        const gate = input.gate;
        await client.query(
          `INSERT INTO production_gate_checks
             (organization_id,project_id,goal_id,release_id,gate_id,status,
              owner_role,checked_at,evidence_refs,checked_by,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,'passed',$6,$7,$8::jsonb,$9,$10,$10)
           ON CONFLICT (release_id,gate_id) DO UPDATE
             SET owner_role=EXCLUDED.owner_role,checked_at=EXCLUDED.checked_at,
                 evidence_refs=EXCLUDED.evidence_refs,
                 checked_by=EXCLUDED.checked_by,updated_at=EXCLUDED.updated_at`,
          [
            value.organizationId, value.projectId, value.goalId, value.id,
            gate.gateId, gate.ownerRole, gate.checkedAt,
            JSON.stringify(gate.evidenceRefs), gate.checkedBy,
            input.command.occurredAt,
          ],
        );
      }
      await insertAudit(
        client,
        input.command,
        "production_release",
        value.id,
        value.version,
      );
      if (input.signature) {
        const signature = input.signature;
        await client.query(
          `INSERT INTO production_release_signatures
             (organization_id,project_id,goal_id,release_id,role,signer_id,
              signed_at,decision,reason,authentication_method,request_id,
              audit_receipt_id,attestation_digest,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',$8,'oidc',$9,$10,$11,$12)`,
          [
            value.organizationId, value.projectId, value.goalId, value.id,
            signature.role, signature.signerId, signature.signedAt,
            signature.reason, signature.requestId, signature.auditReceiptId,
            signature.attestationDigest, input.command.occurredAt,
          ],
        );
      }
      await complete(client, input.command, "production_release", value);
      await client.query("COMMIT");
      return json(value);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      databaseError(error);
    } finally {
      client.release();
    }
  }
}
