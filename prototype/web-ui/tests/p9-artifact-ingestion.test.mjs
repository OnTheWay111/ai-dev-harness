import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactIngestionService } from
  "../app/control-plane/application/artifact-ingestion-service.ts";
import { ArtifactDownloadService } from
  "../app/control-plane/application/artifact-download-service.ts";
import { MemoryEvidenceRepository } from
  "../app/control-plane/adapters/memory-evidence-repository.ts";
import { MemoryObjectStore } from
  "../app/control-plane/adapters/memory-object-store.ts";

const context = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
  issueId: "00000000-0000-4000-8000-000000000004",
  runId: "00000000-0000-4000-8000-000000000005",
};

async function* chunked(...values) {
  for (const value of values) yield new TextEncoder().encode(value);
}

function harness(options = {}) {
  const objectStore = new MemoryObjectStore({
    clock: () => new Date("2026-08-05T04:00:00.000Z"),
  });
  const repository = new MemoryEvidenceRepository();
  return {
    objectStore,
    repository,
    service: new ArtifactIngestionService({
      objectStore,
      repository,
      clock: () => new Date("2026-08-05T04:00:00.000Z"),
      idFactory: () => "10000000-0000-4000-8000-000000000001",
      maxTextBytes: options.maxTextBytes ?? 1024 * 1024,
      allowRawCapture: options.allowRawCapture ?? false,
    }),
  };
}

test("redacts secrets, identities, and paths before digesting and persisting metadata", async () => {
  const { service, repository, objectStore } = harness();
  const record = await service.ingest({
    ...context,
    kind: "run_log",
    mediaType: "text/plain; charset=utf-8",
    source: chunked(
      "token=synthetic-", "secret-value user=engineer@example.com ",
      "path=/Users/private/dev/repo bearer abcdefghijklmnop",
    ),
    createdBy: "worker-1",
    secretValues: ["synthetic-secret-value"],
    identityValues: ["engineer@example.com"],
    retentionPolicy: "standard_180d",
  });
  const stored = await objectStore.read({ scope: context, objectKey: record.objectKey });
  const text = new TextDecoder().decode(stored);
  assert.doesNotMatch(text, /synthetic-secret-value|engineer@example.com|\/Users\/private/);
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /\[REDACTED_IDENTITY\]/);
  assert.match(text, /\[REDACTED_PATH\]/);
  assert.equal(repository.artifacts()[0].digest, record.digest);
  assert.equal("content" in repository.artifacts()[0], false);
});

test("truncates oversized logs safely and rejects binary/raw evidence by default", async () => {
  const { service, objectStore } = harness({ maxTextBytes: 64 });
  const record = await service.ingest({
    ...context,
    kind: "test_output",
    mediaType: "text/plain",
    source: chunked("x".repeat(117), "synthetic-secret-after-limit"),
    createdBy: "worker-1",
    secretValues: ["synthetic-secret-after-limit"],
    retentionPolicy: "standard_180d",
  });
  const text = new TextDecoder().decode(await objectStore.read({
    scope: context,
    objectKey: record.objectKey,
  }));
  assert.ok(new TextEncoder().encode(text).byteLength <= 64);
  assert.match(text, /\[TRUNCATED:/);
  assert.doesNotMatch(text, /synthetic-secret-after-limit/);

  await assert.rejects(() => service.ingest({
    ...context,
    kind: "build_result",
    mediaType: "application/octet-stream",
    source: (async function* () { yield Uint8Array.from([0, 1, 2, 3]); })(),
    createdBy: "worker-1",
    retentionPolicy: "standard_180d",
  }), /binary/i);
  await assert.rejects(() => service.ingest({
    ...context,
    kind: "prompt",
    mediaType: "text/plain",
    source: chunked("raw prompt"),
    createdBy: "worker-1",
    retentionPolicy: "standard_180d",
    captureRaw: true,
    rawCaptureAuthorized: true,
  }), /raw capture is disabled/i);
});

test("issues only short-lived downloads after a separate visibility check", async () => {
  const { service, repository, objectStore } = harness();
  const artifact = await service.ingest({
    ...context,
    kind: "prompt",
    mediaType: "text/plain",
    source: chunked("safe prompt"),
    createdBy: "planner-1",
    retentionPolicy: "standard_180d",
  });
  const downloads = new ArtifactDownloadService({
    repository,
    objectStore,
    clock: () => new Date("2026-08-05T04:00:00.000Z"),
  });
  await assert.rejects(() => downloads.createGrant({
    artifactId: artifact.id,
    actorId: "viewer-other",
    visibility: { actorId: "viewer-other", organizationIds: [], projectIds: [] },
  }), /not found/i);
  const grant = await downloads.createGrant({
    artifactId: artifact.id,
    actorId: "viewer-1",
    visibility: { actorId: "viewer-1", organizationIds: [], projectIds: [context.projectId] },
  });
  assert.equal(grant.artifact.digest, artifact.digest);
  assert.equal(grant.expiresAt, "2026-08-05T04:05:00.000Z");
  assert.doesNotMatch(JSON.stringify(grant.artifact), /objectKey|object_key/);
});
