import type {
  GitCredentialScope,
} from "../domain/delivery-policy.ts";
import type { SecretManagerPort } from
  "../ports/credential-broker-port.ts";

interface CredentialLeaseResponse {
  leaseId: string;
  token: string;
  expiresAt: string;
  scopes: GitCredentialScope[];
}

export class HttpSecretManager implements SecretManagerPort {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly workloadIdentityToken: () => Promise<string>;

  constructor(input: {
    endpoint: string;
    fetcher?: typeof fetch;
    workloadIdentityToken(): Promise<string>;
  }) {
    const endpoint = new URL(input.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash) {
      throw new Error("Secret Manager endpoint must be a clean HTTPS URL");
    }
    this.endpoint = input.endpoint.replace(/\/$/, "");
    this.fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis);
    this.workloadIdentityToken = input.workloadIdentityToken;
  }

  async issueCredential(input: {
    externalReference: string;
    scopes: readonly GitCredentialScope[];
    ttlSeconds: number;
  }) {
    const authorization = await this.workloadIdentityToken();
    if (!authorization) throw new Error("Secret Manager workload identity is unavailable");
    const response = await this.fetcher(
      `${this.endpoint}/v1/git-credential-leases`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${authorization}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          credentialReference: input.externalReference,
          scopes: input.scopes,
          ttlSeconds: input.ttlSeconds,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Secret Manager credential issue failed with HTTP ${response.status}`);
    }
    const lease = await response.json() as CredentialLeaseResponse;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(lease.leaseId) ||
      !lease.token || !Number.isFinite(Date.parse(lease.expiresAt)) ||
      !Array.isArray(lease.scopes)) {
      throw new Error("Secret Manager returned an invalid credential lease");
    }
    return {
      token: lease.token,
      expiresAt: lease.expiresAt,
      scopes: lease.scopes,
      revoke: async () => {
        const token = await this.workloadIdentityToken();
        const revoked = await this.fetcher(
          `${this.endpoint}/v1/git-credential-leases/${encodeURIComponent(lease.leaseId)}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (!revoked.ok && revoked.status !== 404) {
          throw new Error(
            `Secret Manager credential revoke failed with HTTP ${revoked.status}`,
          );
        }
      },
    };
  }
}
