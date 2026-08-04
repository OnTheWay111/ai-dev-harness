import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryArtifactStore } from
  "../app/control-plane/adapters/memory-artifact-store.ts";
import { MemorySpecRevisionRepository } from
  "../app/control-plane/adapters/memory-spec-revision-repository.ts";
import { FileSystemArtifactStore } from
  "../app/control-plane/adapters/filesystem-artifact-store.ts";
import { PostgresSpecRevisionRepository } from
  "../app/control-plane/adapters/postgres-spec-revision-repository.ts";
import { FakePlannerAdapter } from
  "../app/control-plane/adapters/fake-planner-adapter.ts";
import { SpecGenerationService } from
  "../app/control-plane/application/spec-generation-service.ts";
import {
  specBundleOutputSchema,
  SpecBundleValidationError,
  validateSpecBundle,
} from "../app/control-plane/domain/spec-artifact.ts";

const goal = {
  id: "00000000-0000-4000-8000-000000000003",
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  title: "Ship approval gates",
  problemStatement: "Specs cannot be reviewed safely.",
  desiredOutcome: "Only approved immutable specs enter compilation.",
  acceptanceCriteria: [
    {
      id: "ac-1",
      position: 1,
      statement: "An approver can review an immutable proposal and PRD.",
      version: 1,
    },
  ],
  nonGoals: ["Automatic production deployment"],
  constraints: ["All approval decisions are audited"],
  status: "planning",
  version: 4,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T01:00:00.000Z",
};

const validBundle = {
  schemaVersion: "spec-bundle.v1",
  proposal: {
    summary: "Add a human approval gate for immutable specs.",
    value: "Prevents stale or unreviewed plans from reaching execution.",
    inScope: ["Proposal and PRD review"],
    outOfScope: ["Issue compilation"],
    deliverySlices: ["Generate and review a versioned spec"],
  },
  prd: {
    problem: "Specs cannot be reviewed safely.",
    users: ["Approver"],
    requirements: [
      {
        id: "REQ-1",
        statement: "Show an immutable Proposal and PRD revision.",
        acceptanceCriterionRefs: ["ac-1"],
      },
    ],
    nonGoals: ["Automatic production deployment"],
    constraints: ["All approval decisions are audited"],
  },
  architecture: {
    summary: "Use an application service and an immutable Artifact Store.",
    components: [
      {
        id: "artifact-store",
        name: "Artifact Store",
        responsibility: "Persist content-addressed spec bundles.",
        requirementRefs: ["REQ-1"],
      },
    ],
    decisions: ["Keep large content outside PostgreSQL"],
  },
  migration: {
    required: true,
    steps: ["Expand the spec revision metadata"],
    verification: ["Generate and retrieve one immutable revision"],
  },
  rollback: {
    triggers: ["Artifact retrieval fails"],
    steps: ["Disable spec generation and retain existing revisions"],
    dataRecovery: "No data rewrite; existing content-addressed artifacts remain.",
  },
  solutionElements: [
    {
      id: "EL-1",
      title: "Immutable artifact storage",
      kind: "architecture",
      description: "Store every spec revision by digest.",
      acceptanceCriterionRefs: ["ac-1"],
      constraintRefs: [],
      estimatedCost: "medium",
      removalImpact: "Approvers could review mutable content.",
      evidence: ["REQ-1"],
    },
  ],
};

test("exports a closed JSON schema and strictly validates a complete spec bundle", () => {
  assert.equal(specBundleOutputSchema.additionalProperties, false);
  assert.deepEqual(validateSpecBundle(validBundle), validBundle);
  assert.throws(
    () => validateSpecBundle({ ...validBundle, approval: "automatic" }),
    (error) => error instanceof SpecBundleValidationError,
  );
});

test("generates and saves an immutable artifact-backed SpecRevision", async () => {
  const planner = new FakePlannerAdapter([validBundle]);
  const artifacts = new MemoryArtifactStore();
  const repository = new MemorySpecRevisionRepository();
  const service = new SpecGenerationService({
    planner,
    artifacts,
    repository,
    goals: { async get() { return goal; } },
    authorizer: { async authorize() {} },
    clock: () => new Date("2026-08-04T02:00:00.000Z"),
    idGenerator: () => "00000000-0000-4000-8000-000000000099",
    plannerConfiguration: {
      adapter: "fake",
      modelProfile: "planner-test",
      schemaVersion: "spec-bundle.v1",
    },
  });

  const receipt = await service.generate({
    organizationId: goal.organizationId,
    projectId: goal.projectId,
    goalId: goal.id,
    actorId: "approver-1",
    expectedGoalVersion: 4,
    reason: "Create the first reviewable contract",
  });

  assert.equal(receipt.specRevision.revision, 1);
  assert.equal(receipt.specRevision.status, "draft");
  assert.equal(receipt.specRevision.sourceGoalVersion, 4);
  assert.match(receipt.specRevision.artifactDigest, /^[0-9a-f]{64}$/);
  assert.equal(receipt.specRevision.generatedAt, "2026-08-04T02:00:00.000Z");
  assert.deepEqual(receipt.artifact.content, validBundle);
  assert.equal(
    (await artifacts.get(receipt.specRevision.artifactRef))?.digest,
    receipt.specRevision.artifactDigest,
  );
});

test("regeneration appends a revision and never overwrites prior artifact content", async () => {
  const secondBundle = structuredClone(validBundle);
  secondBundle.proposal.summary = "A revised approval gate proposal.";
  const planner = new FakePlannerAdapter([validBundle, secondBundle]);
  const artifacts = new MemoryArtifactStore();
  const repository = new MemorySpecRevisionRepository();
  const service = new SpecGenerationService({
    planner, artifacts, repository,
    goals: { async get() { return goal; } },
    authorizer: { async authorize() {} },
  });
  const command = {
    organizationId: goal.organizationId,
    projectId: goal.projectId,
    goalId: goal.id,
    actorId: "approver-1",
    expectedGoalVersion: 4,
    reason: "Regenerate after review",
  };
  const first = await service.generate(command);
  const second = await service.generate(command);

  assert.equal(second.specRevision.revision, 2);
  assert.equal(second.specRevision.previousRevisionId, first.specRevision.id);
  assert.notEqual(second.specRevision.artifactRef, first.specRevision.artifactRef);
  assert.deepEqual((await artifacts.get(first.specRevision.artifactRef))?.content, validBundle);
});

test("invalid Planner output and artifact storage failure do not append a revision", async () => {
  const repository = new MemorySpecRevisionRepository();
  const base = {
    repository,
    goals: { async get() { return goal; } },
    authorizer: { async authorize() {} },
  };
  const command = {
    organizationId: goal.organizationId,
    projectId: goal.projectId,
    goalId: goal.id,
    actorId: "approver-1",
    expectedGoalVersion: 4,
    reason: "Generate a reviewable contract",
  };
  await assert.rejects(
    () => new SpecGenerationService({
      ...base,
      planner: new FakePlannerAdapter([{ ...validBundle, unknown: true }]),
      artifacts: new MemoryArtifactStore(),
    }).generate(command),
    (error) => error instanceof SpecBundleValidationError,
  );
  await assert.rejects(
    () => new SpecGenerationService({
      ...base,
      planner: new FakePlannerAdapter([validBundle]),
      artifacts: { async put() { throw new Error("store unavailable"); }, async get() { return null; } },
    }).generate(command),
    /store unavailable/,
  );
  assert.deepEqual((await repository.list({
    organizationId: goal.organizationId,
    projectId: goal.projectId,
    goalId: goal.id,
  })).revisions, []);
});

test("filesystem artifact storage uses an immutable content-addressed path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spec-artifacts-"));
  try {
    const store = new FileSystemArtifactStore(directory);
    const first = await store.put({
      content: validBundle,
      createdAt: "2026-08-04T02:00:00.000Z",
      createdBy: "approver-1",
    });
    const second = await store.put({
      content: validBundle,
      createdAt: "2026-08-04T03:00:00.000Z",
      createdBy: "approver-2",
    });
    assert.equal(second.ref, first.ref);
    assert.deepEqual((await store.get(first.ref))?.content, validBundle);
    const stored = JSON.parse(await readFile(
      join(directory, "sha256", `${first.digest}.json`),
      "utf8",
    ));
    assert.equal(stored.createdAt, "2026-08-04T02:00:00.000Z");
    assert.equal(stored.createdBy, "approver-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PostgreSQL append locks the Goal and revision chain before insertion", async () => {
  const queries = [];
  const client = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (/SELECT version FROM goals/.test(text)) return { rows: [{ version: 4 }], rowCount: 1 };
      if (/SELECT id FROM spec_revisions/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO spec_revisions/.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: null };
    },
    release() {},
  };
  const repository = new PostgresSpecRevisionRepository({
    async connect() { return client; },
    async query() { return { rows: [], rowCount: 0 }; },
  });
  const artifact = await new MemoryArtifactStore().put({
    content: validBundle,
    createdAt: "2026-08-04T02:00:00.000Z",
    createdBy: "approver-1",
  });
  const revision = {
    id: "00000000-0000-4000-8000-000000000099",
    organizationId: goal.organizationId,
    projectId: goal.projectId,
    goalId: goal.id,
    revision: 1,
    previousRevisionId: null,
    status: "draft",
    sourceGoalVersion: 4,
    artifactRef: artifact.ref,
    artifactDigest: artifact.digest,
    artifactMediaType: artifact.mediaType,
    artifactSizeBytes: artifact.sizeBytes,
    plannerRunId: "planner-run-1",
    plannerConfiguration: {
      adapter: "fake",
      modelProfile: "planner-test",
      schemaVersion: "spec-bundle.v1",
    },
    generatedAt: "2026-08-04T02:00:00.000Z",
    version: 1,
    createdAt: "2026-08-04T02:00:00.000Z",
    updatedAt: "2026-08-04T02:00:00.000Z",
  };
  await repository.append({
    revision,
    expectedGoalVersion: 4,
    expectedPreviousRevisionId: null,
  });
  assert.match(queries[1].text, /FOR UPDATE/);
  assert.match(queries[2].text, /FOR UPDATE/);
  assert.match(queries[3].text, /planner_configuration/);
  assert.equal(queries.at(-1).text, "COMMIT");
});
