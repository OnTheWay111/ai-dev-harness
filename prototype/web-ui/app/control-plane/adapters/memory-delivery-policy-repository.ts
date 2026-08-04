import type {
  CredentialReference,
  ProjectDeliveryPolicy,
} from "../domain/delivery-policy.ts";
import type { DeliveryPolicyRepository } from
  "../ports/delivery-policy-repository.ts";

export class MemoryDeliveryPolicyRepository
  implements DeliveryPolicyRepository
{
  private readonly policies: readonly ProjectDeliveryPolicy[];
  private readonly credentials: readonly CredentialReference[];

  constructor(input: {
    policies?: readonly ProjectDeliveryPolicy[];
    credentials?: readonly CredentialReference[];
  } = {}) {
    this.policies = structuredClone(input.policies ?? []);
    this.credentials = structuredClone(input.credentials ?? []);
  }

  async findPolicy(input: {
    organizationId: string;
    projectId: string;
    repositoryId: string;
  }): Promise<ProjectDeliveryPolicy | null> {
    const policy = this.policies.filter((candidate) =>
      candidate.organizationId === input.organizationId &&
      candidate.projectId === input.projectId &&
      candidate.repositoryId === input.repositoryId
    ).sort((left, right) => right.revision - left.revision)[0];
    return policy ? structuredClone(policy) : null;
  }

  async findCredentialReference(
    id: string,
  ): Promise<CredentialReference | null> {
    const credential = this.credentials.find((candidate) => candidate.id === id);
    return credential ? structuredClone(credential) : null;
  }
}
