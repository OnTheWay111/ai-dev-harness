import type {
  CredentialReference,
  ProjectDeliveryPolicy,
} from "../domain/delivery-policy.ts";

export interface DeliveryPolicyRepository {
  findPolicy(input: {
    organizationId: string;
    projectId: string;
    repositoryId: string;
  }): Promise<ProjectDeliveryPolicy | null>;
  findCredentialReference(id: string): Promise<CredentialReference | null>;
}
