export const artifactRetentionPolicies = [
  "standard_180d",
  "extended_365d",
  "legal_hold",
] as const;

export type ArtifactRetentionPolicy =
  (typeof artifactRetentionPolicies)[number];

export interface ArtifactObjectScope {
  organizationId: string;
  projectId: string;
}

export interface ImmutableObjectDescriptor extends ArtifactObjectScope {
  objectKey: string;
  digest: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  createdBy: string;
  retentionPolicy: ArtifactRetentionPolicy;
  retentionUntil: string;
  deduplicated: boolean;
}

export interface ImmutableObjectUpload {
  scope: ArtifactObjectScope;
  body: AsyncIterable<Uint8Array>;
  expectedDigest?: string;
  mediaType: string;
  maxBytes: number;
  createdAt: string;
  createdBy: string;
  retentionPolicy: ArtifactRetentionPolicy;
  retentionUntil: string;
}

export interface ObjectDownloadGrant {
  url: string;
  expiresAt: string;
}

export class ObjectStoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStoreValidationError";
  }
}

export class ObjectDigestMismatchError extends ObjectStoreValidationError {
  constructor() {
    super("Uploaded object did not match its expected SHA-256 digest");
    this.name = "ObjectDigestMismatchError";
  }
}

export class ObjectScopeViolationError extends ObjectStoreValidationError {
  constructor() {
    super("Object key is outside the authorized tenant scope");
    this.name = "ObjectScopeViolationError";
  }
}

export class ObjectSizeLimitError extends ObjectStoreValidationError {
  constructor() {
    super("Uploaded object exceeds the configured size limit");
    this.name = "ObjectSizeLimitError";
  }
}

export interface ObjectStorePort {
  putImmutable(input: ImmutableObjectUpload): Promise<ImmutableObjectDescriptor>;
  read(input: {
    scope: ArtifactObjectScope;
    objectKey: string;
  }): Promise<Uint8Array | null>;
  createDownloadGrant(input: {
    scope: ArtifactObjectScope;
    objectKey: string;
    actorId: string;
    expiresInSeconds: number;
  }): Promise<ObjectDownloadGrant>;
}

const SCOPE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function validateObjectScope(scope: ArtifactObjectScope): void {
  if (!SCOPE_COMPONENT.test(scope.organizationId) ||
    !SCOPE_COMPONENT.test(scope.projectId)) {
    throw new ObjectStoreValidationError("Object tenant scope is invalid");
  }
}

export function scopedObjectKey(
  scope: ArtifactObjectScope,
  digest: string,
): string {
  validateObjectScope(scope);
  if (!SHA256.test(digest)) {
    throw new ObjectStoreValidationError("Object digest is invalid");
  }
  return `${scope.organizationId}/${scope.projectId}/sha256/${digest}`;
}

export function assertObjectKeyScope(
  scope: ArtifactObjectScope,
  objectKey: string,
): void {
  validateObjectScope(scope);
  const prefix = `${scope.organizationId}/${scope.projectId}/sha256/`;
  if (!objectKey.startsWith(prefix) ||
    !SHA256.test(objectKey.slice(prefix.length)) ||
    objectKey.includes("..") || objectKey.startsWith("/")) {
    throw new ObjectScopeViolationError();
  }
}

export function validateObjectUpload(input: ImmutableObjectUpload): void {
  validateObjectScope(input.scope);
  if (!input.mediaType.trim() || input.mediaType.length > 200 ||
    !input.createdBy.trim() || input.createdBy.length > 200 ||
    !artifactRetentionPolicies.includes(input.retentionPolicy) ||
    !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    !Number.isFinite(Date.parse(input.retentionUntil)) ||
    Date.parse(input.retentionUntil) <= Date.parse(input.createdAt) ||
    input.expectedDigest !== undefined && !SHA256.test(input.expectedDigest)) {
    throw new ObjectStoreValidationError("Immutable object metadata is invalid");
  }
}

export function validateDownloadGrant(input: {
  actorId: string;
  expiresInSeconds: number;
}): void {
  if (!input.actorId.trim() || input.actorId.length > 200 ||
    !Number.isSafeInteger(input.expiresInSeconds) ||
    input.expiresInSeconds < 1 || input.expiresInSeconds > 300) {
    throw new ObjectStoreValidationError(
      "Download grants require an actor and expire within five minutes",
    );
  }
}
