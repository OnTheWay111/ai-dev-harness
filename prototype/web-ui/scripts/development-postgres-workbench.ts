export interface DevelopmentPostgresEvidence {
  source: string;
  revision: number;
  ssrRevision: number;
  taskCounts: Record<string, number>;
  attentionPageSizes: number[];
  attentionTotal: number;
  goalTotal: number;
  runningTotal: number;
  etagReturned: boolean;
  notModifiedStatus: number;
  cleanupSnapshotCount: number;
  cleanupTaskCount: number;
}

const EXPECTED_TASK_COUNTS = {
  all: 7,
  attention: 4,
  running: 1,
  review: 1,
  blocked: 2,
  waiting: 3,
};

export function validateDevelopmentPostgresEvidence(
  evidence: DevelopmentPostgresEvidence,
): void {
  if (evidence.source !== "postgres") {
    throw new Error("P1-03 expected x-workbench-source=postgres");
  }
  if (evidence.revision !== 103 || evidence.ssrRevision !== evidence.revision) {
    throw new Error("P1-03 SSR and API revision mismatch");
  }
  const taskCountKeys = Object.keys(evidence.taskCounts).sort();
  const expectedTaskCountKeys = Object.keys(EXPECTED_TASK_COUNTS).sort();
  if (
    JSON.stringify(taskCountKeys) !== JSON.stringify(expectedTaskCountKeys) ||
    expectedTaskCountKeys.some(
      (key) => evidence.taskCounts[key] !== EXPECTED_TASK_COUNTS[
        key as keyof typeof EXPECTED_TASK_COUNTS
      ],
    )
  ) {
    throw new Error("P1-03 summary task counts mismatch");
  }
  if (
    JSON.stringify(evidence.attentionPageSizes) !== JSON.stringify([2, 2]) ||
    evidence.attentionTotal !== 4 ||
    evidence.goalTotal !== 4 ||
    evidence.runningTotal !== 1
  ) {
    throw new Error("P1-03 filter or pagination mismatch");
  }
  if (!evidence.etagReturned || evidence.notModifiedStatus !== 304) {
    throw new Error("P1-03 ETag revalidation mismatch");
  }
  if (
    evidence.cleanupSnapshotCount !== 0 ||
    evidence.cleanupTaskCount !== 0
  ) {
    throw new Error("P1-03 isolated scope cleanup failed");
  }
}
