import type { ArtifactKind } from "../domain/artifact-evidence.ts";

export interface ExecutionArtifactContext {
  organizationId: string;
  projectId: string;
  goalId: string;
  issueId: string;
  runId: string;
}

export interface ExecutionArtifactSink {
  capture(input: {
    context: ExecutionArtifactContext;
    kind: ArtifactKind;
    mediaType: string;
    content: string;
    createdBy: string;
    secretValues: readonly string[];
  }): Promise<void>;
}
