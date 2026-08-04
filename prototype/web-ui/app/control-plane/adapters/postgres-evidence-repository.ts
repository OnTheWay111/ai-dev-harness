import type { PostgresPool } from "./postgres-goal-repository.ts";
import type {
  ArtifactEvidenceRecord,
  ArtifactKind,
} from "../domain/artifact-evidence.ts";
import type {
  ReviewerIdentity,
  ReviewFinding,
  ReviewRecord,
  ReviewVerdict,
} from "../domain/review.ts";
import type {
  CapabilityTier,
  ReasoningEffort,
} from "../domain/model-router.ts";
import type {
  EvidenceRepository,
  EvidenceScope,
} from "../ports/evidence-repository.ts";

interface ArtifactRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  issue_id: string;
  run_id: string;
  artifact_kind: ArtifactKind;
  object_key: string;
  digest: string;
  media_type: string;
  size_bytes: string | number;
  created_by_actor_id: string;
  retention_policy: ArtifactEvidenceRecord["retentionPolicy"];
  retention_until: Date;
  created_at: Date;
}

type StoredObjectRow = Omit<
  ArtifactRow,
  "goal_id" | "issue_id" | "run_id"
>;

interface ReviewRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  issue_id: string;
  run_id: string;
  idempotency_key: string;
  request_hash: string;
  target_commit_sha: string;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  builder_identity: string;
  reviewer_type: "human" | "model";
  reviewer_identity: string;
  reviewer_version: string;
  model_capability: string | null;
  reasoning_effort: string | null;
  input_artifact_digests: string[];
  reviewed_at: Date;
  version: number;
}

const artifactColumns = `
  object.id,object.organization_id,object.project_id,
  evidence.goal_id,evidence.issue_id,evidence.run_id,
  object.artifact_kind,object.object_key,object.digest,object.media_type,
  object.size_bytes,object.created_by_actor_id,object.retention_policy,
  object.retention_until,object.created_at`;

const reviewColumns = `
  id,organization_id,project_id,goal_id,issue_id,run_id,idempotency_key,
  request_hash,target_commit_sha,verdict,findings,builder_identity,
  reviewer_type,reviewer_identity,reviewer_version,model_capability,
  reasoning_effort,input_artifact_digests,reviewed_at,version`;

function evidenceKind(kind: ArtifactKind): string {
  if (kind === "run_log") return "log";
  if (kind === "test_output") return "test";
  return "artifact";
}

function mapArtifact(row: ArtifactRow): ArtifactEvidenceRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    issueId: row.issue_id,
    runId: row.run_id,
    kind: row.artifact_kind,
    objectKey: row.object_key,
    digest: row.digest,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    createdBy: row.created_by_actor_id,
    retentionPolicy: row.retention_policy,
    retentionUntil: row.retention_until.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function mapReview(row: ReviewRow): ReviewRecord {
  const base = {
    type: row.reviewer_type,
    identity: row.reviewer_identity,
    version: row.reviewer_version,
  };
  const reviewer: ReviewerIdentity = row.reviewer_type === "model"
    ? {
        ...base,
        type: "model",
        modelCapability: row.model_capability as CapabilityTier,
        reasoningEffort: row.reasoning_effort as ReasoningEffort,
      }
    : { ...base, type: "human" };
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    issueId: row.issue_id,
    runId: row.run_id,
    idempotencyKey: row.idempotency_key,
    targetCommitSha: row.target_commit_sha,
    verdict: row.verdict,
    findings: row.findings,
    builderIdentity: row.builder_identity,
    reviewer,
    inputArtifactDigests: row.input_artifact_digests,
    reviewedAt: row.reviewed_at.toISOString(),
    version: row.version,
  };
}

export class PostgresEvidenceRepository implements EvidenceRepository {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async saveArtifact(
    record: ArtifactEvidenceRecord,
  ): Promise<ArtifactEvidenceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO artifact_objects
          (id,organization_id,project_id,object_key,digest,artifact_kind,
           media_type,size_bytes,created_by_actor_id,retention_policy,
           retention_until,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (organization_id,project_id,artifact_kind,digest)
         DO NOTHING`,
        [
          record.id, record.organizationId, record.projectId, record.objectKey,
          record.digest, record.kind, record.mediaType, record.sizeBytes,
          record.createdBy, record.retentionPolicy, record.retentionUntil,
          record.createdAt,
        ],
      );
      const object = await client.query<StoredObjectRow>(
        `SELECT id,organization_id,project_id,artifact_kind,object_key,digest,
                media_type,size_bytes,created_by_actor_id,retention_policy,
                retention_until,created_at
           FROM artifact_objects
          WHERE organization_id=$1 AND project_id=$2
            AND artifact_kind=$3 AND digest=$4
          FOR UPDATE`,
        [record.organizationId, record.projectId, record.kind, record.digest],
      );
      const stored = object.rows[0];
      if (!stored) throw new Error("Immutable Artifact metadata was not persisted");
      const persisted: ArtifactEvidenceRecord = {
        ...record,
        id: stored.id,
        kind: stored.artifact_kind,
        objectKey: stored.object_key,
        digest: stored.digest,
        mediaType: stored.media_type,
        sizeBytes: Number(stored.size_bytes),
        createdBy: stored.created_by_actor_id,
        retentionPolicy: stored.retention_policy,
        retentionUntil: stored.retention_until.toISOString(),
        createdAt: stored.created_at.toISOString(),
      };
      await client.query(
        `INSERT INTO evidence
          (organization_id,project_id,goal_id,issue_id,run_id,kind,artifact_ref,
           digest,media_type,size_bytes,retention_until,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (organization_id,project_id,goal_id,run_id,kind,digest)
         DO NOTHING`,
        [
          persisted.organizationId, persisted.projectId, persisted.goalId,
          persisted.issueId, persisted.runId, evidenceKind(persisted.kind),
          persisted.objectKey, persisted.digest, persisted.mediaType,
          persisted.sizeBytes, persisted.retentionUntil, persisted.createdAt,
        ],
      );
      await client.query("COMMIT");
      return persisted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findArtifactByDigest(
    scope: EvidenceScope,
    digest: string,
  ): Promise<ArtifactEvidenceRecord | null> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT ${artifactColumns}
         FROM evidence evidence
         JOIN artifact_objects object
           ON object.organization_id=evidence.organization_id
          AND object.project_id=evidence.project_id
          AND object.digest=evidence.digest
        WHERE evidence.organization_id=$1 AND evidence.project_id=$2
          AND evidence.goal_id=$3 AND evidence.issue_id=$4
          AND evidence.run_id=$5 AND evidence.digest=$6
        ORDER BY object.created_at DESC
        LIMIT 1`,
      [
        scope.organizationId, scope.projectId, scope.goalId, scope.issueId,
        scope.runId, digest,
      ],
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  }

  async findArtifactById(input: {
    organizationId: string;
    projectId: string;
    artifactId: string;
  }): Promise<ArtifactEvidenceRecord | null> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT ${artifactColumns}
         FROM artifact_objects object
         JOIN evidence evidence
           ON evidence.organization_id=object.organization_id
          AND evidence.project_id=object.project_id
          AND evidence.digest=object.digest
        WHERE object.organization_id=$1 AND object.project_id=$2 AND object.id=$3
        ORDER BY evidence.created_at DESC
        LIMIT 1`,
      [input.organizationId, input.projectId, input.artifactId],
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  }

  async findVisibleArtifact(input: {
    artifactId: string;
    organizationIds: readonly string[];
    projectIds: readonly string[];
  }): Promise<ArtifactEvidenceRecord | null> {
    if (input.organizationIds.length === 0 && input.projectIds.length === 0) {
      return null;
    }
    const result = await this.pool.query<ArtifactRow>(
      `SELECT ${artifactColumns}
         FROM artifact_objects object
         JOIN evidence evidence
           ON evidence.organization_id=object.organization_id
          AND evidence.project_id=object.project_id
          AND evidence.digest=object.digest
        WHERE object.id=$1
          AND (object.organization_id=ANY($2::uuid[])
            OR object.project_id=ANY($3::uuid[]))
        ORDER BY evidence.created_at DESC
        LIMIT 1`,
      [input.artifactId, input.organizationIds, input.projectIds],
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  }

  async listArtifacts(
    scope: EvidenceScope,
  ): Promise<readonly ArtifactEvidenceRecord[]> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT ${artifactColumns}
         FROM evidence evidence
         JOIN artifact_objects object
           ON object.organization_id=evidence.organization_id
          AND object.project_id=evidence.project_id
          AND object.digest=evidence.digest
        WHERE evidence.organization_id=$1 AND evidence.project_id=$2
          AND evidence.goal_id=$3 AND evidence.issue_id=$4
          AND evidence.run_id=$5
        ORDER BY object.created_at,object.id`,
      [
        scope.organizationId, scope.projectId, scope.goalId, scope.issueId,
        scope.runId,
      ],
    );
    return result.rows.map(mapArtifact);
  }

  async findReviewByIdempotency(input: {
    organizationId: string;
    runId: string;
    idempotencyKey: string;
  }): Promise<{ review: ReviewRecord; requestHash: string } | null> {
    const result = await this.pool.query<ReviewRow>(
      `SELECT ${reviewColumns} FROM reviews
        WHERE organization_id=$1 AND run_id=$2 AND idempotency_key=$3`,
      [input.organizationId, input.runId, input.idempotencyKey],
    );
    const row = result.rows[0];
    return row ? { review: mapReview(row), requestHash: row.request_hash } : null;
  }

  async saveReview(input: {
    review: ReviewRecord;
    requestHash: string;
  }): Promise<ReviewRecord> {
    const reviewer = input.review.reviewer;
    const inserted = await this.pool.query<ReviewRow>(
      `INSERT INTO reviews
        (id,organization_id,project_id,goal_id,issue_id,run_id,idempotency_key,
         request_hash,target_commit_sha,verdict,findings,builder_identity,
         reviewer_type,reviewer_identity,reviewer_version,model_capability,
         reasoning_effort,input_artifact_digests,reviewed_at,version,
         created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,
               $16,$17,$18::jsonb,$19,$20,$19,$19)
       ON CONFLICT (organization_id,run_id,idempotency_key)
       DO NOTHING
       RETURNING ${reviewColumns}`,
      [
        input.review.id, input.review.organizationId, input.review.projectId,
        input.review.goalId, input.review.issueId, input.review.runId,
        input.review.idempotencyKey, input.requestHash,
        input.review.targetCommitSha, input.review.verdict,
        JSON.stringify(input.review.findings), input.review.builderIdentity,
        reviewer.type, reviewer.identity, reviewer.version,
        reviewer.type === "model" ? reviewer.modelCapability : null,
        reviewer.type === "model" ? reviewer.reasoningEffort : null,
        JSON.stringify(input.review.inputArtifactDigests),
        input.review.reviewedAt, input.review.version,
      ],
    );
    const existing = inserted.rows[0] ? null : await this.pool.query<ReviewRow>(
      `SELECT ${reviewColumns} FROM reviews
        WHERE organization_id=$1 AND run_id=$2 AND idempotency_key=$3`,
      [
        input.review.organizationId,
        input.review.runId,
        input.review.idempotencyKey,
      ],
    );
    const row = inserted.rows[0] ?? existing?.rows[0];
    if (!row || row.request_hash !== input.requestHash) {
      throw new Error("Review idempotency conflict");
    }
    return mapReview(row);
  }

  async findApprovedReview(input: {
    organizationId: string;
    projectId: string;
    issueId: string;
    runId: string;
    targetCommitSha: string;
  }): Promise<ReviewRecord | null> {
    const result = await this.pool.query<ReviewRow>(
      `SELECT ${reviewColumns} FROM reviews
        WHERE organization_id=$1 AND project_id=$2 AND issue_id=$3
          AND run_id=$4 AND target_commit_sha=$5 AND verdict='approved'
        ORDER BY reviewed_at DESC,id DESC LIMIT 1`,
      [
        input.organizationId, input.projectId, input.issueId, input.runId,
        input.targetCommitSha,
      ],
    );
    return result.rows[0] ? mapReview(result.rows[0]) : null;
  }

  async listReviews(scope: EvidenceScope): Promise<readonly ReviewRecord[]> {
    const result = await this.pool.query<ReviewRow>(
      `SELECT ${reviewColumns} FROM reviews
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
          AND issue_id=$4 AND run_id=$5
        ORDER BY reviewed_at,id`,
      [
        scope.organizationId, scope.projectId, scope.goalId, scope.issueId,
        scope.runId,
      ],
    );
    return result.rows.map(mapReview);
  }
}
