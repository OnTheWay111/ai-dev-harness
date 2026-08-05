import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  assertObjectKeyScope,
  ObjectDigestMismatchError,
  ObjectSizeLimitError,
  ObjectStoreValidationError,
  type ArtifactObjectScope,
  type ImmutableObjectDescriptor,
  type ImmutableObjectUpload,
  type ObjectDownloadGrant,
  type ObjectStorePort,
  scopedObjectKey,
  validateDownloadGrant,
  validateObjectUpload,
} from "../ports/object-store-port.ts";
import { artifactObjectLockInput } from
  "../../reliability/recovery-policy.ts";

export interface S3ObjectStoreOptions {
  client: S3Client;
  bucket: string;
  keyPrefix?: string;
  clock?: () => Date;
}

function notFound(error: unknown): boolean {
  const value = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return value.name === "NotFound" || value.name === "NoSuchKey" ||
    value.$metadata?.httpStatusCode === 404;
}

function alreadyExists(error: unknown): boolean {
  const value = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return value.name === "PreconditionFailed" ||
    value.$metadata?.httpStatusCode === 412;
}

export class S3ObjectStore implements ObjectStorePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly clock: () => Date;

  constructor(options: S3ObjectStoreOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,252}$/.test(options.bucket)) {
      throw new ObjectStoreValidationError("S3 artifact bucket is invalid");
    }
    if (options.keyPrefix?.includes("..") || options.keyPrefix?.startsWith("/")) {
      throw new ObjectStoreValidationError("S3 artifact prefix is invalid");
    }
    this.client = options.client;
    this.bucket = options.bucket;
    this.keyPrefix = options.keyPrefix?.replace(/\/$/, "") ?? "";
    this.clock = options.clock ?? (() => new Date());
  }

  async putImmutable(
    input: ImmutableObjectUpload,
  ): Promise<ImmutableObjectDescriptor> {
    validateObjectUpload(input);
    const stagingDirectory = await mkdtemp(join(tmpdir(), "p9-s3-upload-"));
    const temporary = join(stagingDirectory, "artifact.upload");
    const handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const value of input.body) {
        const chunk = new Uint8Array(value);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > input.maxBytes) throw new ObjectSizeLimitError();
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      const digest = hash.digest("hex");
      if (input.expectedDigest && input.expectedDigest !== digest) {
        throw new ObjectDigestMismatchError();
      }
      const objectKey = scopedObjectKey(input.scope, digest);
      const key = this.remoteKey(objectKey);
      const existing = await this.head(key);
      if (existing) {
        this.assertRemoteIntegrity(existing, digest, sizeBytes);
        return this.descriptor(input, objectKey, digest, sizeBytes, true);
      }
      try {
        await this.client.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: createReadStream(temporary),
          ContentLength: sizeBytes,
          ContentType: input.mediaType,
          ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
          IfNoneMatch: "*",
          Metadata: {
            digest,
            organization: input.scope.organizationId,
            project: input.scope.projectId,
          },
          ServerSideEncryption: "AES256",
          ...artifactObjectLockInput(
            input.retentionPolicy,
            input.retentionUntil,
          ),
        }));
      } catch (error) {
        if (!alreadyExists(error)) throw error;
        const raced = await this.head(key);
        if (!raced) throw error;
        this.assertRemoteIntegrity(raced, digest, sizeBytes);
        return this.descriptor(input, objectKey, digest, sizeBytes, true);
      }
      const uploaded = await this.head(key);
      if (!uploaded) {
        throw new ObjectStoreValidationError(
          "S3 did not expose a completed immutable upload receipt",
        );
      }
      this.assertRemoteIntegrity(uploaded, digest, sizeBytes);
      return this.descriptor(input, objectKey, digest, sizeBytes, false);
    } finally {
      await handle.close().catch(() => undefined);
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async read(input: {
    scope: ArtifactObjectScope;
    objectKey: string;
  }): Promise<Uint8Array | null> {
    assertObjectKeyScope(input.scope, input.objectKey);
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.remoteKey(input.objectKey),
      }));
      if (!response.Body) return new Uint8Array();
      return new Uint8Array(await response.Body.transformToByteArray());
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async createDownloadGrant(input: {
    scope: ArtifactObjectScope;
    objectKey: string;
    actorId: string;
    expiresInSeconds: number;
  }): Promise<ObjectDownloadGrant> {
    assertObjectKeyScope(input.scope, input.objectKey);
    validateDownloadGrant(input);
    const key = this.remoteKey(input.objectKey);
    if (!await this.head(key)) throw new Error("Immutable object was not found");
    const expiresAt = new Date(
      this.clock().getTime() + input.expiresInSeconds * 1_000,
    );
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: "attachment",
      }),
      { expiresIn: input.expiresInSeconds },
    );
    return { url, expiresAt: expiresAt.toISOString() };
  }

  private remoteKey(objectKey: string): string {
    return this.keyPrefix ? `${this.keyPrefix}/${objectKey}` : objectKey;
  }

  private async head(key: string) {
    try {
      return await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  private assertRemoteIntegrity(
    head: { ContentLength?: number; Metadata?: Record<string, string> },
    digest: string,
    sizeBytes: number,
  ): void {
    if (head.ContentLength !== sizeBytes || head.Metadata?.digest !== digest) {
      throw new ObjectStoreValidationError(
        "Existing S3 object failed immutable digest verification",
      );
    }
  }

  private descriptor(
    input: ImmutableObjectUpload,
    objectKey: string,
    digest: string,
    sizeBytes: number,
    deduplicated: boolean,
  ): ImmutableObjectDescriptor {
    return {
      ...input.scope,
      objectKey,
      digest,
      mediaType: input.mediaType,
      sizeBytes,
      createdAt: input.createdAt,
      createdBy: input.createdBy,
      retentionPolicy: input.retentionPolicy,
      retentionUntil: input.retentionUntil,
      deduplicated,
    };
  }
}
