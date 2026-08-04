export interface IssueDependencyEdge {
  from: string;
  to: string;
}

export interface StoredIssueDependency {
  issueId: string;
  dependsOnIssueId: string;
}

export interface SerializablePlanningRecord {
  kind: string;
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  createdAt: Date;
  updatedAt?: Date;
  [key: string]: Date | number | string | undefined;
}

export function serializePlanningRecord(
  record: SerializablePlanningRecord,
): string {
  for (const [name, value] of Object.entries(record)) {
    if (value instanceof Date && Number.isNaN(value.getTime())) {
      throw new Error(`Planning record has an invalid ${name}`);
    }
  }
  return JSON.stringify(record);
}

export function toIssueDependencyEdges(
  dependencies: readonly StoredIssueDependency[],
): IssueDependencyEdge[] {
  return dependencies.map(({ issueId, dependsOnIssueId }) => ({
    from: dependsOnIssueId,
    to: issueId,
  }));
}
