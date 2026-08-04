export const deliveryCandidateStates = [
  "verified",
  "committed",
  "reviewed",
  "local_ready",
  "branch_pushed",
  "pr_open",
  "landing",
  "landed",
  "failed",
] as const;
export type DeliveryCandidateState =
  (typeof deliveryCandidateStates)[number];

export interface PushReceipt {
  receiptId: string;
  remoteName: string;
  remoteBranch: string;
  commitSha: string;
  pushedAt: string;
}

export interface PullRequestReceipt {
  externalId: string;
  url: string;
  headBranch: string;
  baseBranch: string;
}

export interface LandingReceipt {
  externalId: string;
  landingCommitSha: string;
  landedAt: string;
}

export interface DeliveryCandidate {
  id: string;
  organizationId: string;
  projectId: string;
  repositoryId: string;
  goalId: string;
  issueId: string;
  runId: string;
  worktreePath: string;
  baselineBranch: string;
  baselineSha: string;
  branch: string;
  commitMessage: string;
  commitSha: string | null;
  reviewId?: string;
  pushReceipt?: PushReceipt;
  pullRequest?: PullRequestReceipt;
  landing?: LandingReceipt;
  state: DeliveryCandidateState;
  version: number;
}

export interface DeliveryAuditEvent {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  candidateId: string;
  actorId: string;
  action: string;
  entityVersion: number;
  operationKey: string;
  occurredAt: string;
  /** Only stable IDs, refs, and digests are allowed here. */
  details: Readonly<Record<string, unknown>>;
}
