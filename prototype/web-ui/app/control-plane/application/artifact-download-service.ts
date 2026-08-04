import type { ActorVisibilityScope } from "../../auth/visibility-scope.ts";
import type { EvidenceRepository } from
  "../ports/evidence-repository.ts";
import type { ObjectStorePort } from
  "../ports/object-store-port.ts";

export class ArtifactDownloadError extends Error {
  readonly code: "not_found" | "expired";

  constructor(code: "not_found" | "expired", message: string) {
    super(message);
    this.name = "ArtifactDownloadError";
    this.code = code;
  }
}

export class ArtifactDownloadService {
  private readonly repository: EvidenceRepository;
  private readonly objectStore: ObjectStorePort;
  private readonly clock: () => Date;

  constructor(input: {
    repository: EvidenceRepository;
    objectStore: ObjectStorePort;
    clock?: () => Date;
  }) {
    this.repository = input.repository;
    this.objectStore = input.objectStore;
    this.clock = input.clock ?? (() => new Date());
  }

  async createGrant(input: {
    artifactId: string;
    actorId: string;
    visibility: ActorVisibilityScope;
  }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.artifactId)) {
      throw new ArtifactDownloadError("not_found", "Artifact was not found");
    }
    const artifact = await this.repository.findVisibleArtifact({
      artifactId: input.artifactId,
      organizationIds: input.visibility.organizationIds,
      projectIds: input.visibility.projectIds,
    });
    if (!artifact) {
      throw new ArtifactDownloadError("not_found", "Artifact was not found");
    }
    if (artifact.retentionPolicy !== "legal_hold" &&
      Date.parse(artifact.retentionUntil) <= this.clock().getTime()) {
      throw new ArtifactDownloadError(
        "expired",
        "Artifact retention has expired",
      );
    }
    const grant = await this.objectStore.createDownloadGrant({
      scope: artifact,
      objectKey: artifact.objectKey,
      actorId: input.actorId,
      expiresInSeconds: 300,
    });
    return {
      artifact: {
        id: artifact.id,
        kind: artifact.kind,
        digest: artifact.digest,
        mediaType: artifact.mediaType,
        sizeBytes: artifact.sizeBytes,
        createdAt: artifact.createdAt,
      },
      downloadUrl: grant.url,
      expiresAt: grant.expiresAt,
    };
  }
}
