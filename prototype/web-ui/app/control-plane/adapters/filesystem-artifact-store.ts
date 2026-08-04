import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  canonicalJson,
  sha256Hex,
} from "../domain/spec-artifact.ts";
import type {
  ArtifactStore,
  ImmutableArtifact,
} from "../ports/artifact-store.ts";

interface StoredArtifactEnvelope<T = unknown> {
  digest: string;
  mediaType: "application/json";
  sizeBytes: number;
  content: T;
  createdAt: string;
  createdBy: string;
}

export class ArtifactIntegrityError extends Error {
  constructor() {
    super("The immutable artifact failed its digest verification");
    this.name = "ArtifactIntegrityError";
  }
}

function artifactRef(digest: string): string {
  return `artifact://sha256/${digest}`;
}

function digestFromRef(ref: string): string | null {
  return /^artifact:\/\/sha256\/([0-9a-f]{64})$/.exec(ref)?.[1] ?? null;
}

export class FileSystemArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("Artifact Store path must be absolute");
    this.root = root;
  }

  async put<T>(input: {
    content: T;
    createdAt: string;
    createdBy: string;
  }): Promise<ImmutableArtifact<T>> {
    const canonical = canonicalJson(input.content);
    const digest = await sha256Hex(canonical);
    const sizeBytes = new TextEncoder().encode(canonical).byteLength;
    const directory = join(this.root, "sha256");
    const target = join(directory, `${digest}.json`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const envelope: StoredArtifactEnvelope<T> = {
      digest,
      mediaType: "application/json",
      sizeBytes,
      content: input.content,
      createdAt: input.createdAt,
      createdBy: input.createdBy,
    };
    const temporary = join(directory, `${digest}.${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(envelope), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    const stored = await this.read<T>(digest);
    if (!stored) throw new ArtifactIntegrityError();
    return stored;
  }

  async get<T = unknown>(ref: string): Promise<ImmutableArtifact<T> | null> {
    const digest = digestFromRef(ref);
    return digest ? await this.read<T>(digest) : null;
  }

  private async read<T>(digest: string): Promise<ImmutableArtifact<T> | null> {
    let serialized: string;
    try {
      serialized = await readFile(join(this.root, "sha256", `${digest}.json`), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
    let envelope: StoredArtifactEnvelope<T>;
    try {
      envelope = JSON.parse(serialized) as StoredArtifactEnvelope<T>;
    } catch {
      throw new ArtifactIntegrityError();
    }
    const canonical = canonicalJson(envelope.content);
    const calculated = await sha256Hex(canonical);
    const sizeBytes = new TextEncoder().encode(canonical).byteLength;
    if (
      envelope.digest !== digest ||
      calculated !== digest ||
      envelope.mediaType !== "application/json" ||
      envelope.sizeBytes !== sizeBytes
    ) throw new ArtifactIntegrityError();
    return {
      ref: artifactRef(digest),
      digest,
      mediaType: "application/json",
      sizeBytes,
      content: envelope.content,
      createdAt: envelope.createdAt,
      createdBy: envelope.createdBy,
    };
  }
}
