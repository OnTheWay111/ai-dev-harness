import type {
  SpecRevision,
  SpecRevisionTimeline,
} from "../domain/spec-artifact.ts";

export interface SpecRevisionScope {
  organizationId: string;
  projectId: string;
  goalId: string;
}

export interface SpecRevisionRepository {
  list(scope: SpecRevisionScope): Promise<SpecRevisionTimeline>;
  append(input: {
    revision: SpecRevision;
    expectedGoalVersion: number;
    expectedPreviousRevisionId: string | null;
  }): Promise<SpecRevision>;
}
