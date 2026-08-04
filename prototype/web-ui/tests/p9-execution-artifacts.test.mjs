import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactIngestionExecutionSink } from
  "../app/control-plane/adapters/artifact-ingestion-execution-sink.ts";
import { AutoDevCliExecutionGateway } from
  "../app/control-plane/adapters/autodev-cli-execution-gateway.ts";
import { MemoryEvidenceRepository } from
  "../app/control-plane/adapters/memory-evidence-repository.ts";
import { MemoryObjectStore } from
  "../app/control-plane/adapters/memory-object-store.ts";
import { ArtifactIngestionService } from
  "../app/control-plane/application/artifact-ingestion-service.ts";

test("execution gateway persists redacted stdout, stderr, and failure evidence", async () => {
  const objectStore = new MemoryObjectStore();
  const repository = new MemoryEvidenceRepository();
  const sink = new ArtifactIngestionExecutionSink(new ArtifactIngestionService({
    objectStore,
    repository,
    clock: () => new Date("2026-08-05T05:00:00.000Z"),
  }));
  const gateway = new AutoDevCliExecutionGateway({
    pythonExecutable: "/usr/bin/python3",
    projectConfigPath: "/srv/autodev/project.yaml",
    trustedRunnerEnforcesNetwork: true,
    environment: { PATH: "/usr/bin" },
    secretResolver: async () => ({ AUTODEV_API_TOKEN: "synthetic-runtime-secret" }),
    artifactSink: sink,
    workspaceManager: {
      async create() { return "/tmp/p9-execution-artifacts"; },
      async cleanup() {},
    },
    processRunner: async () => ({
      exitCode: 1,
      stdout: '{"status":"failed","message":"synthetic-runtime-secret"}',
      stderr: "test failed token=synthetic-runtime-secret /Users/private/repo",
    }),
  });
  const context = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    goalId: "00000000-0000-4000-8000-000000000003",
    issueId: "00000000-0000-4000-8000-000000000004",
    runId: "00000000-0000-4000-8000-000000000005",
  };
  const result = await gateway.start({
    externalTaskId: "H-001",
    externalRunId: "cp-run-1-a1",
    selectedSecrets: ["AUTODEV_API_TOKEN"],
    timeoutMs: 1_000,
    artifactContext: context,
  });
  assert.equal(result.state, "failed");
  const artifacts = repository.artifacts();
  assert.deepEqual(artifacts.map((artifact) => artifact.kind).sort(), [
    "failure_evidence", "run_log",
  ]);
  for (const artifact of artifacts) {
    const stored = new TextDecoder().decode(await objectStore.read({
      scope: context,
      objectKey: artifact.objectKey,
    }));
    assert.doesNotMatch(stored, /synthetic-runtime-secret|\/Users\/private/);
  }
});
