import { PostgresRoleBindingRepository } from "../../auth/postgres-role-binding-repository.ts";
import { PolicyEvaluator } from "../../auth/rbac-policy.ts";
import { CodexPlannerAdapter } from "../adapters/codex-planner-adapter.ts";
import { DemoSpecPlannerAdapter } from "../adapters/demo-spec-planner-adapter.ts";
import { FileSystemArtifactStore } from "../adapters/filesystem-artifact-store.ts";
import { MemoryArtifactStore } from "../adapters/memory-artifact-store.ts";
import { MemorySpecRevisionRepository } from "../adapters/memory-spec-revision-repository.ts";
import { PostgresSpecRevisionRepository } from "../adapters/postgres-spec-revision-repository.ts";
import {
  SpecGenerationService,
  type SpecGenerationAuthorizer,
} from "../application/spec-generation-service.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { SpecRevisionRepository } from "../ports/spec-revision-repository.ts";
import {
  getGoalWorkspacePool,
  getGoalWorkspaceRepository,
  usesDemoGoalWorkspace,
} from "./goal-workspace-runtime.ts";

let service: SpecGenerationService | undefined;
let repository: SpecRevisionRepository | undefined;
let artifacts: ArtifactStore | undefined;

function getArtifacts(): ArtifactStore {
  if (artifacts) return artifacts;
  if (usesDemoGoalWorkspace()) {
    artifacts = new MemoryArtifactStore();
    return artifacts;
  }
  const root = process.env.ARTIFACT_STORE_PATH?.trim();
  if (!root) throw new Error("ARTIFACT_STORE_PATH is required for PostgreSQL-backed SpecRevisions");
  artifacts = new FileSystemArtifactStore(root);
  return artifacts;
}

function getRepository(): SpecRevisionRepository {
  if (repository) return repository;
  repository = usesDemoGoalWorkspace()
    ? new MemorySpecRevisionRepository()
    : new PostgresSpecRevisionRepository(getGoalWorkspacePool());
  return repository;
}

function getAuthorizer(): SpecGenerationAuthorizer {
  if (usesDemoGoalWorkspace()) return { async authorize() {} };
  const policy = new PolicyEvaluator(
    new PostgresRoleBindingRepository(getGoalWorkspacePool()),
  );
  return { async authorize(input) { await policy.assertAllowed(input); } };
}

export function getSpecGenerationService(): SpecGenerationService {
  if (service) return service;
  const demo = usesDemoGoalWorkspace();
  const modelProfile = process.env.CODEX_PLANNER_MODEL?.trim() || "configured-planner";
  service = new SpecGenerationService({
    planner: demo
      ? new DemoSpecPlannerAdapter()
      : new CodexPlannerAdapter({ model: process.env.CODEX_PLANNER_MODEL?.trim() }),
    artifacts: getArtifacts(),
    repository: getRepository(),
    goals: getGoalWorkspaceRepository(),
    authorizer: getAuthorizer(),
    plannerConfiguration: {
      adapter: demo ? "demo" : "codex",
      modelProfile: demo ? "deterministic-demo" : modelProfile,
      schemaVersion: "spec-bundle.v1",
    },
  });
  return service;
}
