import { VersionConflictError } from "./errors.ts";
import type { SpecRevision } from "./spec-artifact.ts";

export class SpecCompilationGateError extends Error {
  readonly code = "spec_not_approved" as const;

  constructor() {
    super("Only the latest approved SpecRevision can enter Issue compilation");
    this.name = "SpecCompilationGateError";
  }
}

/**
 * The mandatory P5→P6 boundary. A caller must load both the requested revision
 * and the latest revision in the same scope before invoking the Issue compiler.
 */
export function requireCompilableSpecRevision(input: {
  candidate: SpecRevision;
  latest: SpecRevision;
  expectedVersion: number;
}): SpecRevision {
  if (
    input.candidate.id !== input.latest.id ||
    input.candidate.version !== input.latest.version ||
    input.candidate.version !== input.expectedVersion
  ) {
    throw new VersionConflictError();
  }
  if (input.candidate.status !== "approved" || input.latest.status !== "approved") {
    throw new SpecCompilationGateError();
  }
  return input.latest;
}
