export const pushModes = [
  "push_disabled",
  "push_branch",
  "push_and_open_pr",
] as const;
export type PushMode = (typeof pushModes)[number];

export const gitCredentialScopes = [
  "contents:write",
  "pull_requests:write",
] as const;
export type GitCredentialScope = (typeof gitCredentialScopes)[number];

export interface ProjectDeliveryPolicy {
  id: string;
  organizationId: string;
  projectId: string;
  repositoryId: string;
  mode: PushMode;
  baselineBranch: string;
  branchPrefix: string;
  protectedBranches: readonly string[];
  credentialReferenceId: string | null;
  revision: number;
}

export interface CredentialReference {
  id: string;
  organizationId: string;
  projectId: string;
  repositoryId: string;
  provider: "github_app" | "git_token";
  externalReference: string;
  allowedScopes: readonly GitCredentialScope[];
  active: boolean;
  version: number;
}

export interface DeliveryTarget {
  organizationId: string;
  projectId: string;
  repositoryId: string;
  baselineBranch: string;
  baselineSha: string;
  branch: string;
  commitSha: string;
}
