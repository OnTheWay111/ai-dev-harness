import { S3Client } from "@aws-sdk/client-s3";

import { readRequestPrincipal } from "../../auth/oidc-http.ts";
import { getOidcService } from "../../auth/oidc-runtime.ts";
import { configuredWriteOrigins } from "../../security/request-security.ts";
import { getWorkbenchVisibilityResolver } from
  "../../workbench/server/workbench-repository-factory.ts";
import { FileSystemObjectStore } from
  "../adapters/filesystem-object-store.ts";
import { MemoryEvidenceRepository } from
  "../adapters/memory-evidence-repository.ts";
import { MemoryObjectStore } from "../adapters/memory-object-store.ts";
import { PostgresEvidenceRepository } from
  "../adapters/postgres-evidence-repository.ts";
import { S3ObjectStore } from "../adapters/s3-object-store.ts";
import { ArtifactDownloadService } from
  "../application/artifact-download-service.ts";
import { createArtifactDownloadHandler } from
  "../http/artifact-download-handler.ts";
import type { EvidenceRepository } from
  "../ports/evidence-repository.ts";
import type { ObjectStorePort } from "../ports/object-store-port.ts";
import {
  getGoalWorkspacePool,
  usesDemoGoalWorkspace,
} from "./goal-workspace-runtime.ts";

let objectStore: ObjectStorePort | undefined;
let evidenceRepository: EvidenceRepository | undefined;
let handler: ReturnType<typeof createArtifactDownloadHandler> | undefined;

function objectStoreMode(): "memory" | "filesystem" | "s3" {
  const configured = process.env.ARTIFACT_OBJECT_STORE?.trim();
  if (configured === "memory" || configured === "filesystem" || configured === "s3") {
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Production requires ARTIFACT_OBJECT_STORE=s3");
  }
  return usesDemoGoalWorkspace() ? "memory" : "filesystem";
}

export function getArtifactObjectStore(): ObjectStorePort {
  if (objectStore) return objectStore;
  const mode = objectStoreMode();
  if (mode === "memory") {
    objectStore = new MemoryObjectStore();
    return objectStore;
  }
  if (mode === "filesystem") {
    const root = process.env.ARTIFACT_FILESYSTEM_ROOT?.trim();
    const downloadBaseUrl = process.env.ARTIFACT_DOWNLOAD_BASE_URL?.trim();
    const signingSecret = process.env.ARTIFACT_DOWNLOAD_SIGNING_SECRET?.trim();
    if (!root || !downloadBaseUrl || !signingSecret) {
      throw new Error("Filesystem Artifact Store configuration is incomplete");
    }
    objectStore = new FileSystemObjectStore({
      root,
      downloadBaseUrl,
      signingSecret,
    });
    return objectStore;
  }
  const region = process.env.ARTIFACT_S3_REGION?.trim();
  const bucket = process.env.ARTIFACT_S3_BUCKET?.trim();
  if (!region || !bucket) {
    throw new Error("S3 Artifact Store region and bucket are required");
  }
  objectStore = new S3ObjectStore({
    client: new S3Client({
      region,
      endpoint: process.env.ARTIFACT_S3_ENDPOINT?.trim() || undefined,
      forcePathStyle: process.env.ARTIFACT_S3_FORCE_PATH_STYLE === "true",
    }),
    bucket,
    keyPrefix: process.env.ARTIFACT_S3_PREFIX?.trim() || undefined,
  });
  return objectStore;
}

export function getEvidenceRepository(): EvidenceRepository {
  evidenceRepository ??= usesDemoGoalWorkspace()
    ? new MemoryEvidenceRepository()
    : new PostgresEvidenceRepository(getGoalWorkspacePool());
  return evidenceRepository;
}

export function getArtifactDownloadHandler() {
  handler ??= createArtifactDownloadHandler({
    service: new ArtifactDownloadService({
      repository: getEvidenceRepository(),
      objectStore: getArtifactObjectStore(),
    }),
    actorResolver: async (request) =>
      await readRequestPrincipal(request, getOidcService()),
    visibilityResolver: async (request) => {
      const principal = await readRequestPrincipal(request, getOidcService());
      return principal
        ? await getWorkbenchVisibilityResolver().resolve(principal.actorId)
        : { actorId: "anonymous", organizationIds: [], projectIds: [] };
    },
    allowedOrigins: configuredWriteOrigins(),
  });
  return handler;
}
