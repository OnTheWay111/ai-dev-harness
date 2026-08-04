import { createHash } from "node:crypto";

import {
  assertObjectKeyScope,
  ObjectDigestMismatchError,
  ObjectSizeLimitError,
  type ImmutableObjectDescriptor,
  type ImmutableObjectUpload,
  type ObjectDownloadGrant,
  type ObjectStorePort,
  scopedObjectKey,
  validateDownloadGrant,
  validateObjectUpload,
} from "../ports/object-store-port.ts";

interface MemoryObject {
  bytes: Uint8Array;
  descriptor: ImmutableObjectDescriptor;
}

async function collect(input: ImmutableObjectUpload): Promise<{
  bytes: Uint8Array;
  digest: string;
}> {
  const chunks: Uint8Array[] = [];
  const digest = createHash("sha256");
  let size = 0;
  for await (const value of input.body) {
    const chunk = new Uint8Array(value);
    size += chunk.byteLength;
    if (size > input.maxBytes) throw new ObjectSizeLimitError();
    chunks.push(chunk);
    digest.update(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, digest: digest.digest("hex") };
}

export class MemoryObjectStore implements ObjectStorePort {
  private readonly objects = new Map<string, MemoryObject>();
  private readonly clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  objectCount(): number {
    return this.objects.size;
  }

  async putImmutable(
    input: ImmutableObjectUpload,
  ): Promise<ImmutableObjectDescriptor> {
    validateObjectUpload(input);
    const { bytes, digest } = await collect(input);
    if (input.expectedDigest && input.expectedDigest !== digest) {
      throw new ObjectDigestMismatchError();
    }
    const objectKey = scopedObjectKey(input.scope, digest);
    const existing = this.objects.get(objectKey);
    if (existing) {
      return { ...structuredClone(existing.descriptor), deduplicated: true };
    }
    const descriptor: ImmutableObjectDescriptor = {
      ...input.scope,
      objectKey,
      digest,
      mediaType: input.mediaType,
      sizeBytes: bytes.byteLength,
      createdAt: input.createdAt,
      createdBy: input.createdBy,
      retentionPolicy: input.retentionPolicy,
      retentionUntil: input.retentionUntil,
      deduplicated: false,
    };
    this.objects.set(objectKey, {
      bytes: new Uint8Array(bytes),
      descriptor: structuredClone(descriptor),
    });
    return descriptor;
  }

  async read(input: {
    scope: ImmutableObjectUpload["scope"];
    objectKey: string;
  }): Promise<Uint8Array | null> {
    assertObjectKeyScope(input.scope, input.objectKey);
    const stored = this.objects.get(input.objectKey);
    return stored ? new Uint8Array(stored.bytes) : null;
  }

  async createDownloadGrant(input: {
    scope: ImmutableObjectUpload["scope"];
    objectKey: string;
    actorId: string;
    expiresInSeconds: number;
  }): Promise<ObjectDownloadGrant> {
    assertObjectKeyScope(input.scope, input.objectKey);
    validateDownloadGrant(input);
    if (!this.objects.has(input.objectKey)) {
      throw new Error("Immutable object was not found");
    }
    const expiresAt = new Date(
      this.clock().getTime() + input.expiresInSeconds * 1_000,
    );
    const token = createHash("sha256")
      .update(`${input.actorId}\0${input.objectKey}\0${expiresAt.toISOString()}`)
      .digest("hex");
    return {
      url: `memory://artifacts/${input.objectKey}?expires=${encodeURIComponent(expiresAt.toISOString())}&token=${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }
}
