import type {
  ArtifactRetentionPolicy,
} from "../ports/object-store-port.ts";

export const artifactKinds = [
  "prompt",
  "run_log",
  "test_output",
  "build_result",
  "failure_evidence",
] as const;

export type ArtifactKind = (typeof artifactKinds)[number];

export interface ArtifactEvidenceRecord {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  issueId: string;
  runId: string;
  kind: ArtifactKind;
  objectKey: string;
  digest: string;
  mediaType: string;
  sizeBytes: number;
  createdBy: string;
  retentionPolicy: ArtifactRetentionPolicy;
  retentionUntil: string;
  createdAt: string;
}
