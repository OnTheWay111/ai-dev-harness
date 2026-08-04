import type { ArtifactEvidenceRecord } from
  "../domain/artifact-evidence.ts";
import type { ReviewRecord } from "../domain/review.ts";
import type {
  EvidenceRepository,
  EvidenceScope,
} from "../ports/evidence-repository.ts";

function sameScope(
  record: EvidenceScope,
  scope: EvidenceScope,
): boolean {
  return record.organizationId === scope.organizationId &&
    record.projectId === scope.projectId &&
    record.goalId === scope.goalId &&
    record.issueId === scope.issueId &&
    record.runId === scope.runId;
}

export class MemoryEvidenceRepository implements EvidenceRepository {
  private readonly artifactRecords: ArtifactEvidenceRecord[];
  private readonly reviewRecords: Array<{
    review: ReviewRecord;
    requestHash: string;
  }>;

  constructor(input: {
    artifacts?: readonly ArtifactEvidenceRecord[];
    reviews?: readonly ReviewRecord[];
  } = {}) {
    this.artifactRecords = structuredClone([...(input.artifacts ?? [])]);
    this.reviewRecords = (input.reviews ?? []).map((review) => ({
      review: structuredClone(review),
      requestHash: "seeded",
    }));
  }

  artifacts(): readonly ArtifactEvidenceRecord[] {
    return structuredClone(this.artifactRecords);
  }

  reviews(): readonly ReviewRecord[] {
    return structuredClone(this.reviewRecords.map((entry) => entry.review));
  }

  async saveArtifact(
    record: ArtifactEvidenceRecord,
  ): Promise<ArtifactEvidenceRecord> {
    const existing = this.artifactRecords.find((candidate) =>
      sameScope(candidate, record) && candidate.kind === record.kind &&
      candidate.digest === record.digest
    );
    if (existing) return structuredClone(existing);
    this.artifactRecords.push(structuredClone(record));
    return structuredClone(record);
  }

  async findArtifactByDigest(
    scope: EvidenceScope,
    digest: string,
  ): Promise<ArtifactEvidenceRecord | null> {
    const record = this.artifactRecords.find((candidate) =>
      sameScope(candidate, scope) && candidate.digest === digest
    );
    return record ? structuredClone(record) : null;
  }

  async findArtifactById(input: {
    organizationId: string;
    projectId: string;
    artifactId: string;
  }): Promise<ArtifactEvidenceRecord | null> {
    const record = this.artifactRecords.find((candidate) =>
      candidate.id === input.artifactId &&
      candidate.organizationId === input.organizationId &&
      candidate.projectId === input.projectId
    );
    return record ? structuredClone(record) : null;
  }

  async findVisibleArtifact(input: {
    artifactId: string;
    organizationIds: readonly string[];
    projectIds: readonly string[];
  }): Promise<ArtifactEvidenceRecord | null> {
    const record = this.artifactRecords.find((candidate) =>
      candidate.id === input.artifactId &&
      (input.organizationIds.includes(candidate.organizationId) ||
        input.projectIds.includes(candidate.projectId))
    );
    return record ? structuredClone(record) : null;
  }

  async listArtifacts(
    scope: EvidenceScope,
  ): Promise<readonly ArtifactEvidenceRecord[]> {
    return structuredClone(this.artifactRecords.filter((record) =>
      sameScope(record, scope)
    ));
  }

  async findReviewByIdempotency(input: {
    organizationId: string;
    runId: string;
    idempotencyKey: string;
  }): Promise<{ review: ReviewRecord; requestHash: string } | null> {
    const entry = this.reviewRecords.find((candidate) =>
      candidate.review.organizationId === input.organizationId &&
      candidate.review.runId === input.runId &&
      candidate.review.idempotencyKey === input.idempotencyKey
    );
    return entry ? structuredClone(entry) : null;
  }

  async saveReview(input: {
    review: ReviewRecord;
    requestHash: string;
  }): Promise<ReviewRecord> {
    const existing = await this.findReviewByIdempotency({
      organizationId: input.review.organizationId,
      runId: input.review.runId,
      idempotencyKey: input.review.idempotencyKey,
    });
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new Error("Review idempotency key conflicts with another review");
      }
      return existing.review;
    }
    this.reviewRecords.push(structuredClone(input));
    return structuredClone(input.review);
  }

  async findApprovedReview(input: {
    organizationId: string;
    projectId: string;
    issueId: string;
    runId: string;
    targetCommitSha: string;
  }): Promise<ReviewRecord | null> {
    const records = this.reviewRecords.map((entry) => entry.review)
      .filter((review) =>
        review.organizationId === input.organizationId &&
        review.projectId === input.projectId &&
        review.issueId === input.issueId && review.runId === input.runId &&
        review.targetCommitSha === input.targetCommitSha &&
        review.verdict === "approved"
      )
      .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt));
    return records[0] ? structuredClone(records[0]) : null;
  }

  async listReviews(scope: EvidenceScope): Promise<readonly ReviewRecord[]> {
    return structuredClone(this.reviewRecords.map((entry) => entry.review)
      .filter((record) => sameScope(record, scope)));
  }
}
