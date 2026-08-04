import type {
  CredentialReference,
  DeliveryTarget,
  GitCredentialScope,
  ProjectDeliveryPolicy,
} from "../domain/delivery-policy.ts";
import type { DeliveryPolicyRepository } from
  "../ports/delivery-policy-repository.ts";

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function defaultPolicy(target: DeliveryTarget): ProjectDeliveryPolicy {
  return {
    id: `default:${target.projectId}:${target.repositoryId}`,
    organizationId: target.organizationId,
    projectId: target.projectId,
    repositoryId: target.repositoryId,
    mode: "push_disabled",
    baselineBranch: target.baselineBranch,
    branchPrefix: "autodev/",
    protectedBranches: [target.baselineBranch],
    credentialReferenceId: null,
    revision: 1,
  };
}

export interface DeliveryPolicyDecision {
  policy: ProjectDeliveryPolicy;
  credential: CredentialReference | null;
  requiredScopes: readonly GitCredentialScope[];
}

export class DeliveryPolicyService {
  private readonly repository: DeliveryPolicyRepository;

  constructor(input: { repository: DeliveryPolicyRepository }) {
    this.repository = input.repository;
  }

  async authorize(target: DeliveryTarget): Promise<DeliveryPolicyDecision> {
    if (!GIT_SHA.test(target.baselineSha) || !GIT_SHA.test(target.commitSha) ||
      !BRANCH.test(target.branch) || !BRANCH.test(target.baselineBranch)) {
      throw new Error("Delivery target has an invalid commit or branch");
    }
    const configured = await this.repository.findPolicy(target);
    const policy = configured ?? defaultPolicy(target);
    if (policy.mode === "push_disabled") {
      return { policy, credential: null, requiredScopes: [] };
    }
    if (policy.organizationId !== target.organizationId ||
      policy.projectId !== target.projectId ||
      policy.repositoryId !== target.repositoryId) {
      throw new Error("Delivery repository is not allowed by project policy");
    }
    if (target.baselineBranch !== policy.baselineBranch) {
      throw new Error("Delivery baseline does not match project policy");
    }
    if (policy.protectedBranches.some((pattern) =>
      wildcardMatch(pattern, target.branch)
    )) {
      throw new Error("Direct writes to protected branches are forbidden");
    }
    if (!target.branch.startsWith(policy.branchPrefix)) {
      throw new Error("Delivery branch is outside the allowed prefix");
    }
    if (!policy.credentialReferenceId) {
      throw new Error("Push policy has no credential reference");
    }
    const credential = await this.repository.findCredentialReference(
      policy.credentialReferenceId,
    );
    const requiredScopes: GitCredentialScope[] = policy.mode === "push_branch"
      ? ["contents:write"]
      : ["contents:write", "pull_requests:write"];
    if (!credential || !credential.active ||
      credential.organizationId !== target.organizationId ||
      credential.projectId !== target.projectId ||
      credential.repositoryId !== target.repositoryId ||
      credential.allowedScopes.length !== requiredScopes.length ||
      requiredScopes.some((scope) => !credential.allowedScopes.includes(scope))) {
      throw new Error(
        "Credential reference is unavailable, cross-repository, or over-privileged",
      );
    }
    return { policy, credential, requiredScopes };
  }
}
