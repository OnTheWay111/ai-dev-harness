import { createHash, createHmac, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

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

export interface FileSystemObjectStoreOptions {
  root: string;
  clock?: () => Date;
  downloadBaseUrl: string;
  signingSecret: string;
}

export class FileSystemObjectStore implements ObjectStorePort {
  private readonly root: string;
  private readonly clock: () => Date;
  private readonly downloadBaseUrl: string;
  private readonly signingSecret: string;

  constructor(options: FileSystemObjectStoreOptions) {
    if (!isAbsolute(options.root)) {
      throw new ObjectStoreValidationError("Object store root must be absolute");
    }
    const downloadBase = new URL(options.downloadBaseUrl);
    if (downloadBase.protocol !== "https:") {
      throw new ObjectStoreValidationError("Download base URL must use HTTPS");
    }
    if (options.signingSecret.length < 16) {
      throw new ObjectStoreValidationError("Download signing key is unavailable");
    }
    this.root = options.root;
    this.clock = options.clock ?? (() => new Date());
    this.downloadBaseUrl = options.downloadBaseUrl.replace(/\/$/, "");
    this.signingSecret = options.signingSecret;
  }

  async putImmutable(
    input: ImmutableObjectUpload,
  ): Promise<ImmutableObjectDescriptor> {
    validateObjectUpload(input);
    const staging = join(this.root, ".staging");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const temporary = join(staging, `${randomUUID()}.upload`);
    const handle = await open(temporary, "wx", 0o600);
    const digest = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const value of input.body) {
        const chunk = new Uint8Array(value);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > input.maxBytes) throw new ObjectSizeLimitError();
        digest.update(chunk);
        await handle.write(chunk);
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.sync();
    await handle.close();
    const digestHex = digest.digest("hex");
    if (input.expectedDigest && input.expectedDigest !== digestHex) {
      await rm(temporary, { force: true });
      throw new ObjectDigestMismatchError();
    }
    const objectKey = scopedObjectKey(input.scope, digestHex);
    const target = join(this.root, ...objectKey.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    let deduplicated = false;
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      deduplicated = true;
      const existing = await stat(target);
      const existingDigest = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      if (existing.size !== sizeBytes || existingDigest !== digestHex) {
        throw new ObjectStoreValidationError(
          "Existing immutable object does not match its digest metadata",
        );
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      ...input.scope,
      objectKey,
      digest: digestHex,
      mediaType: input.mediaType,
      sizeBytes,
      createdAt: input.createdAt,
      createdBy: input.createdBy,
      retentionPolicy: input.retentionPolicy,
      retentionUntil: input.retentionUntil,
      deduplicated,
    };
  }

  async read(input: {
    scope: ArtifactObjectScope;
    objectKey: string;
  }): Promise<Uint8Array | null> {
    assertObjectKeyScope(input.scope, input.objectKey);
    try {
      return new Uint8Array(
        await readFile(join(this.root, ...input.objectKey.split("/"))),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
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
    if (await this.read(input) === null) throw new Error("Immutable object was not found");
    const expiresAt = new Date(
      this.clock().getTime() + input.expiresInSeconds * 1_000,
    );
    const expires = Math.floor(expiresAt.getTime() / 1_000);
    const signature = createHmac("sha256", this.signingSecret)
      .update(`${input.actorId}\0${input.objectKey}\0${expires}`)
      .digest("hex");
    return {
      url: `${this.downloadBaseUrl}/${input.objectKey}?actor=${encodeURIComponent(input.actorId)}&expires=${expires}&signature=${signature}`,
      expiresAt: expiresAt.toISOString(),
    };
  }
}
