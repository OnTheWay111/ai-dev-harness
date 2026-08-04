export interface ImmutableArtifact<T = unknown> {
  ref: string;
  digest: string;
  mediaType: "application/json";
  sizeBytes: number;
  content: T;
  createdAt: string;
  createdBy: string;
}

export interface ArtifactStore {
  put<T>(input: {
    content: T;
    createdAt: string;
    createdBy: string;
  }): Promise<ImmutableArtifact<T>>;
  get<T = unknown>(ref: string): Promise<ImmutableArtifact<T> | null>;
}
