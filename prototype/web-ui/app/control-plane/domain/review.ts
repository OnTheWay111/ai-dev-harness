import type { CapabilityTier, ReasoningEffort } from "./model-router.ts";

export const reviewVerdicts = [
  "approved",
  "request_changes",
  "rejected",
] as const;
export type ReviewVerdict = (typeof reviewVerdicts)[number];

export interface ReviewFinding {
  severity: "info" | "warning" | "blocking";
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

export type ReviewerIdentity =
  | {
      type: "human";
      identity: string;
      version: string;
    }
  | {
      type: "model";
      identity: string;
      version: string;
      modelCapability: CapabilityTier;
      reasoningEffort: ReasoningEffort;
    };

export interface ReviewRecord {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  issueId: string;
  runId: string;
  idempotencyKey: string;
  targetCommitSha: string;
  verdict: ReviewVerdict;
  findings: readonly ReviewFinding[];
  builderIdentity: string;
  reviewer: ReviewerIdentity;
  inputArtifactDigests: readonly string[];
  reviewedAt: string;
  version: number;
}

export type SubmitReviewInput = Omit<
  ReviewRecord,
  "id" | "reviewedAt" | "version"
>;
