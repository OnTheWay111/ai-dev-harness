import type { CredentialLease } from "./credential-broker-port.ts";
import type {
  LandingReceipt,
  PullRequestReceipt,
  PushReceipt,
} from "../domain/delivery.ts";

export interface CommitReceipt {
  commitSha: string;
  summary: string;
}

export interface GitDeliveryPort {
  createCommit(input: {
    operationKey: string;
    worktreePath: string;
    branch: string;
    baselineSha: string;
    message: string;
  }): Promise<CommitReceipt>;
  pushBranch(input: {
    operationKey: string;
    worktreePath: string;
    branch: string;
    commitSha: string;
    credential: CredentialLease;
  }): Promise<PushReceipt>;
  openPullRequest(input: {
    operationKey: string;
    repositoryId: string;
    branch: string;
    baselineBranch: string;
    commitSha: string;
    credential: CredentialLease;
  }): Promise<PullRequestReceipt>;
  mergePullRequest(input: {
    operationKey: string;
    repositoryId: string;
    pullRequest: PullRequestReceipt;
    expectedCommitSha: string;
    credential: CredentialLease;
  }): Promise<LandingReceipt>;
}
