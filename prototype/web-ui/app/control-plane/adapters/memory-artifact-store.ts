import {
  canonicalJson,
  sha256Hex,
} from "../domain/spec-artifact.ts";
import type {
  ArtifactStore,
  ImmutableArtifact,
} from "../ports/artifact-store.ts";

export class MemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, ImmutableArtifact>();

  async put<T>(input: {
    content: T;
    createdAt: string;
    createdBy: string;
  }): Promise<ImmutableArtifact<T>> {
    const serialized = canonicalJson(input.content);
    const digest = await sha256Hex(serialized);
    const ref = `memory://artifacts/sha256/${digest}`;
    const existing = this.artifacts.get(ref);
    if (existing) return structuredClone(existing) as ImmutableArtifact<T>;
    const artifact: ImmutableArtifact<T> = {
      ref,
      digest,
      mediaType: "application/json",
      sizeBytes: new TextEncoder().encode(serialized).byteLength,
      content: structuredClone(input.content),
      createdAt: input.createdAt,
      createdBy: input.createdBy,
    };
    this.artifacts.set(ref, structuredClone(artifact));
    return artifact;
  }

  async get<T = unknown>(ref: string): Promise<ImmutableArtifact<T> | null> {
    const artifact = this.artifacts.get(ref);
    return artifact ? structuredClone(artifact) as ImmutableArtifact<T> : null;
  }
}
