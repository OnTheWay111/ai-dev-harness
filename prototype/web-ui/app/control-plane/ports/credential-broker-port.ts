import type {
  CredentialReference,
  GitCredentialScope,
} from "../domain/delivery-policy.ts";

export interface CredentialLease {
  /** Runtime-only material. It must never be persisted, logged, or returned. */
  token: string;
  expiresAt: string;
  scopes: readonly GitCredentialScope[];
  release(): Promise<void>;
}

export interface CredentialBrokerPort {
  acquire(
    reference: CredentialReference,
    requiredScopes: readonly GitCredentialScope[],
  ): Promise<CredentialLease>;
}

export interface SecretManagerPort {
  issueCredential(input: {
    externalReference: string;
    scopes: readonly GitCredentialScope[];
    ttlSeconds: number;
  }): Promise<{
    token: string;
    expiresAt: string;
    scopes: readonly GitCredentialScope[];
    revoke(): Promise<void>;
  }>;
}

export class SecretManagerCredentialBroker implements CredentialBrokerPort {
  private readonly secretManager: SecretManagerPort;
  private readonly clock: () => Date;
  private readonly ttlSeconds: number;

  constructor(input: {
    secretManager: SecretManagerPort;
    clock?: () => Date;
    ttlSeconds?: number;
  }) {
    this.secretManager = input.secretManager;
    this.clock = input.clock ?? (() => new Date());
    this.ttlSeconds = input.ttlSeconds ?? 600;
    if (this.ttlSeconds < 60 || this.ttlSeconds > 900) {
      throw new Error("Git credential lease must be between one and fifteen minutes");
    }
  }

  async acquire(
    reference: CredentialReference,
    requiredScopes: readonly GitCredentialScope[],
  ): Promise<CredentialLease> {
    if (!reference.active || !requiredScopes.every((scope) =>
      reference.allowedScopes.includes(scope)
    )) {
      throw new Error("Credential reference cannot satisfy the requested scope");
    }
    const issued = await this.secretManager.issueCredential({
      externalReference: reference.externalReference,
      scopes: requiredScopes,
      ttlSeconds: this.ttlSeconds,
    });
    const now = this.clock().getTime();
    const expiry = Date.parse(issued.expiresAt);
    const maxExpiry = now + this.ttlSeconds * 1_000;
    if (!issued.token || !Number.isFinite(expiry) || expiry <= now ||
      expiry > maxExpiry ||
      issued.scopes.length !== requiredScopes.length ||
      requiredScopes.some((scope) => !issued.scopes.includes(scope))) {
      await issued.revoke().catch(() => undefined);
      throw new Error("Secret Manager returned an invalid or over-privileged lease");
    }
    return {
      token: issued.token,
      expiresAt: issued.expiresAt,
      scopes: [...issued.scopes],
      release: issued.revoke,
    };
  }
}
