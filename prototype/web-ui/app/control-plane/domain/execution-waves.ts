import type { IssueConflictResources } from "./issue-plan.ts";

export const conflictPolicyRevision = "issue-conflicts.v1" as const;

export type ConflictResourceKind =
  | "file"
  | "directory"
  | "public_interface"
  | "database_object"
  | "shared_configuration"
  | "landing_order";

export interface IssueConflict {
  issueKeys: readonly [string, string];
  resourceKinds: readonly ConflictResourceKind[];
  resourceKeys: readonly string[];
  reasons: readonly string[];
}

export interface ExecutionWave {
  number: number;
  issueKeys: readonly string[];
  reasons: readonly string[];
}

export interface ExecutionWavePlan {
  policyRevision: typeof conflictPolicyRevision;
  conflicts: readonly IssueConflict[];
  waves: readonly ExecutionWave[];
}

interface SchedulableIssue {
  key: string;
  dependencyCandidates: readonly string[];
  expectedFiles: readonly string[];
  conflictResources: IssueConflictResources;
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function directory(value: string): string {
  const normalized = normalizedPath(value).replace(/\/\*\*$/, "");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function intersections(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right.map((value) => value.trim().toLowerCase()));
  return [...new Set(left
    .map((value) => value.trim().toLowerCase())
    .filter((value) => rightSet.has(value)))].sort();
}

function conflictFor(left: SchedulableIssue, right: SchedulableIssue): IssueConflict | null {
  const resourceKinds: ConflictResourceKind[] = [];
  const resourceKeys: string[] = [];
  const reasons: string[] = [];
  const files = intersections(left.expectedFiles.map(normalizedPath), right.expectedFiles.map(normalizedPath));
  if (files.length) {
    resourceKinds.push("file");
    resourceKeys.push(...files.map((value) => `file:${value}`));
    reasons.push(`Both Issues expect to modify ${files.join(", ")}`);
  }
  const leftDirectories = left.conflictResources.directories.map(directory);
  const rightDirectories = right.conflictResources.directories.map(directory);
  const directoryKeys = new Set<string>();
  for (const claimed of leftDirectories) {
    if (rightDirectories.some((candidate) =>
      candidate.startsWith(claimed) || claimed.startsWith(candidate)
    ) || right.expectedFiles.some((file) => normalizedPath(file).startsWith(claimed))) {
      directoryKeys.add(claimed);
    }
  }
  for (const claimed of rightDirectories) {
    if (left.expectedFiles.some((file) => normalizedPath(file).startsWith(claimed))) {
      directoryKeys.add(claimed);
    }
  }
  if (directoryKeys.size) {
    resourceKinds.push("directory");
    resourceKeys.push(...[...directoryKeys].sort().map((value) => `directory:${value}`));
    reasons.push(`Directory claims overlap at ${[...directoryKeys].sort().join(", ")}`);
  }
  const categories: readonly [
    keyof IssueConflictResources,
    ConflictResourceKind,
    string,
  ][] = [
    ["publicInterfaces", "public_interface", "public interface"],
    ["databaseObjects", "database_object", "database object"],
    ["sharedConfigurations", "shared_configuration", "shared configuration"],
    ["landingOrder", "landing_order", "landing order key"],
  ];
  for (const [property, kind, label] of categories) {
    const keys = intersections(left.conflictResources[property], right.conflictResources[property]);
    if (!keys.length) continue;
    resourceKinds.push(kind);
    resourceKeys.push(...keys.map((value) => `${kind}:${value}`));
    reasons.push(`Both Issues claim the same ${label}: ${keys.join(", ")}`);
  }
  if (!resourceKinds.length) return null;
  return {
    issueKeys: [left.key, right.key],
    resourceKinds,
    resourceKeys: [...new Set(resourceKeys)].sort(),
    reasons,
  };
}

export function analyzeIssueConflicts(
  issues: readonly SchedulableIssue[],
): IssueConflict[] {
  const sorted = [...issues].sort((left, right) => left.key.localeCompare(right.key));
  const result: IssueConflict[] = [];
  for (let left = 0; left < sorted.length; left += 1) {
    for (let right = left + 1; right < sorted.length; right += 1) {
      const conflict = conflictFor(sorted[left], sorted[right]);
      if (conflict) result.push(conflict);
    }
  }
  return result;
}

export function scheduleExecutionWaves(
  issues: readonly SchedulableIssue[],
): ExecutionWavePlan {
  const sorted = [...issues].sort((left, right) => left.key.localeCompare(right.key));
  const known = new Set(sorted.map(({ key }) => key));
  const remaining = new Map(sorted.map((issue) => [
    issue.key,
    new Set(issue.dependencyCandidates.filter((dependency) => known.has(dependency))),
  ]));
  const conflicts = analyzeIssueConflicts(sorted);
  const conflictKeys = new Set(conflicts.map(({ issueKeys: [left, right] }) => `${left}\0${right}`));
  const hasConflict = (left: string, right: string) => {
    const ordered = [left, right].sort();
    return conflictKeys.has(`${ordered[0]}\0${ordered[1]}`);
  };
  const waves: ExecutionWave[] = [];
  while (remaining.size) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([key]) => key)
      .sort();
    if (!ready.length) break;
    const selected: string[] = [];
    for (const key of ready) {
      if (selected.every((prior) => !hasConflict(prior, key))) selected.push(key);
    }
    if (!selected.length) selected.push(ready[0]);
    const number = waves.length + 1;
    waves.push({
      number,
      issueKeys: selected,
      reasons: selected.map((key) => {
        const dependencies = sorted.find((issue) => issue.key === key)?.dependencyCandidates ?? [];
        return dependencies.length
          ? `${key} dependencies are complete and no Wave ${number} resource conflicts remain`
          : `${key} has no unmet dependencies and no Wave ${number} resource conflicts`;
      }),
    });
    for (const key of selected) {
      remaining.delete(key);
      for (const dependencies of remaining.values()) dependencies.delete(key);
    }
  }
  return { policyRevision: conflictPolicyRevision, conflicts, waves };
}
