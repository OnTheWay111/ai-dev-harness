import type { PostgresPool } from "./postgres-goal-repository.ts";
import type {
  CredentialReference,
  GitCredentialScope,
  ProjectDeliveryPolicy,
  PushMode,
} from "../domain/delivery-policy.ts";
import type { DeliveryPolicyRepository } from
  "../ports/delivery-policy-repository.ts";

interface PolicyRow {
  id: string;
  organization_id: string;
  project_id: string;
  repository_id: string;
  push_mode: PushMode;
  baseline_branch: string;
  branch_prefix: string;
  protected_branches: string[];
  credential_reference_id: string | null;
  revision: number;
}

interface CredentialRow {
  id: string;
  organization_id: string;
  project_id: string;
  repository_id: string;
  provider: CredentialReference["provider"];
  external_reference: string;
  allowed_scopes: GitCredentialScope[];
  active: boolean;
  version: number;
}

export class PostgresDeliveryPolicyRepository
  implements DeliveryPolicyRepository
{
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async findPolicy(input: {
    organizationId: string;
    projectId: string;
    repositoryId: string;
  }): Promise<ProjectDeliveryPolicy | null> {
    const result = await this.pool.query<PolicyRow>(
      `SELECT id,organization_id,project_id,repository_id,push_mode,
              baseline_branch,branch_prefix,protected_branches,
              credential_reference_id,revision
         FROM delivery_policies
        WHERE organization_id=$1 AND project_id=$2 AND repository_id=$3
        ORDER BY revision DESC,id DESC LIMIT 1`,
      [input.organizationId, input.projectId, input.repositoryId],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      repositoryId: row.repository_id,
      mode: row.push_mode,
      baselineBranch: row.baseline_branch,
      branchPrefix: row.branch_prefix,
      protectedBranches: row.protected_branches,
      credentialReferenceId: row.credential_reference_id,
      revision: row.revision,
    } : null;
  }

  async findCredentialReference(
    id: string,
  ): Promise<CredentialReference | null> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT id,organization_id,project_id,repository_id,provider,
              external_reference,allowed_scopes,active,version
         FROM credential_references WHERE id=$1`,
      [id],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      repositoryId: row.repository_id,
      provider: row.provider,
      externalReference: row.external_reference,
      allowedScopes: row.allowed_scopes,
      active: row.active,
      version: row.version,
    } : null;
  }
}
