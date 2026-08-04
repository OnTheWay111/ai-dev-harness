import type { ArtifactEvidenceRecord } from "../domain/artifact-evidence.ts";
import type { ReviewRecord } from "../domain/review.ts";

export interface EvidenceScope {
  organizationId: string;
  projectId: string;
  goalId: string;
  issueId: string;
  runId: string;
}

export interface EvidenceRepository {
  saveArtifact(record: ArtifactEvidenceRecord): Promise<ArtifactEvidenceRecord>;
  findArtifactByDigest(
    scope: EvidenceScope,
    digest: string,
  ): Promise<ArtifactEvidenceRecord | null>;
  findArtifactById(input: {
    organizationId: string;
    projectId: string;
    artifactId: string;
  }): Promise<ArtifactEvidenceRecord | null>;
  findVisibleArtifact(input: {
    artifactId: string;
    organizationIds: readonly string[];
    projectIds: readonly string[];
  }): Promise<ArtifactEvidenceRecord | null>;
  listArtifacts(scope: EvidenceScope): Promise<readonly ArtifactEvidenceRecord[]>;
  findReviewByIdempotency(input: {
    organizationId: string;
    runId: string;
    idempotencyKey: string;
  }): Promise<{ review: ReviewRecord; requestHash: string } | null>;
  saveReview(input: {
    review: ReviewRecord;
    requestHash: string;
  }): Promise<ReviewRecord>;
  findApprovedReview(input: {
    organizationId: string;
    projectId: string;
    issueId: string;
    runId: string;
    targetCommitSha: string;
  }): Promise<ReviewRecord | null>;
  listReviews(scope: EvidenceScope): Promise<readonly ReviewRecord[]>;
}
