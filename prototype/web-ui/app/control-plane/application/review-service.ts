import { createHash } from "node:crypto";

import {
  reviewVerdicts,
  type ReviewFinding,
  type ReviewRecord,
  type SubmitReviewInput,
} from "../domain/review.ts";
import type { EvidenceRepository } from
  "../ports/evidence-repository.ts";

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function requestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function validateFindings(findings: readonly ReviewFinding[]): void {
  if (findings.length > 500) throw new Error("Review has too many findings");
  for (const finding of findings) {
    if (!finding.title.trim() || finding.title.length > 300 ||
      !finding.detail.trim() || finding.detail.length > 8_000 ||
      finding.file?.startsWith("/") || finding.file?.includes("..") ||
      finding.line !== undefined &&
        (!Number.isSafeInteger(finding.line) || finding.line < 1)) {
      throw new Error("Review finding is invalid or exposes an absolute path");
    }
  }
}

export class ReviewService {
  private readonly repository: EvidenceRepository;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(input: {
    repository: EvidenceRepository;
    clock?: () => Date;
    idFactory?: () => string;
  }) {
    this.repository = input.repository;
    this.clock = input.clock ?? (() => new Date());
    this.idFactory = input.idFactory ?? (() => crypto.randomUUID());
  }

  async submit(input: SubmitReviewInput): Promise<ReviewRecord> {
    if (!COMMIT_SHA.test(input.targetCommitSha)) {
      throw new Error("Review requires an exact Git commit SHA");
    }
    if (!reviewVerdicts.includes(input.verdict) ||
      input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 200 ||
      !input.builderIdentity.trim() || !input.reviewer.identity.trim() ||
      !input.reviewer.version.trim()) {
      throw new Error("Review identity or verdict is invalid");
    }
    if (input.builderIdentity.trim().toLocaleLowerCase("en-US") ===
      input.reviewer.identity.trim().toLocaleLowerCase("en-US")) {
      throw new Error("Builder and Reviewer must be independent identities");
    }
    validateFindings(input.findings);
    const digests = [...new Set(input.inputArtifactDigests)];
    if (digests.length === 0 || digests.some((digest) => !DIGEST.test(digest))) {
      throw new Error("Review requires immutable input artifact digests");
    }
    const scope = {
      organizationId: input.organizationId,
      projectId: input.projectId,
      goalId: input.goalId,
      issueId: input.issueId,
      runId: input.runId,
    };
    for (const digest of digests) {
      if (!await this.repository.findArtifactByDigest(scope, digest)) {
        throw new Error("Review input artifact is missing or belongs to another run");
      }
    }
    const hash = requestHash({ ...input, inputArtifactDigests: digests });
    const existing = await this.repository.findReviewByIdempotency({
      organizationId: input.organizationId,
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new Error("Review idempotency key conflicts with changed evidence");
      }
      return existing.review;
    }
    return await this.repository.saveReview({
      requestHash: hash,
      review: {
        ...structuredClone(input),
        inputArtifactDigests: digests,
        id: this.idFactory(),
        reviewedAt: this.clock().toISOString(),
        version: 1,
      },
    });
  }
}
