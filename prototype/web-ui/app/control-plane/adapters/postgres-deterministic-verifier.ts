import { spawn, type ChildProcess } from "node:child_process";

import type { AcceptanceVerificationEntry } from
  "../domain/acceptance-verification.ts";
import type { DeterministicVerifierPort } from
  "../ports/goal-verifier-port.ts";
import type { GoalVerificationScope } from
  "../ports/goal-verification-repository.ts";
import type { PostgresPool } from "./postgres-goal-repository.ts";
import { builtInVerificationQueries } from
  "./postgres-verification-reference-catalog.ts";

export interface ApprovedVerificationCommand {
  reference: string;
  executable: string;
  arguments: readonly string[];
  cwd: string;
}

async function executeCommand(
  command: ApprovedVerificationCommand,
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; durationMs: number }> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.arguments], {
      cwd: command.cwd,
      env: Object.fromEntries(
        ["PATH", "HOME", "CODEX_HOME", "TMPDIR"].flatMap((name) => {
          const value = process.env[name];
          return value ? [[name, value]] : [];
        }),
      ) as unknown as NodeJS.ProcessEnv,
      stdio: "ignore",
      shell: false,
    }) as unknown as ChildProcess;
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (exitCode: number | null) => {
      signal?.removeEventListener("abort", abort);
      resolve({ exitCode, durationMs: Date.now() - started });
    });
  });
}

export class PostgresDeterministicVerifier implements DeterministicVerifierPort {
  private readonly pool: PostgresPool;
  private readonly commands: ReadonlyMap<string, ApprovedVerificationCommand>;

  constructor(input: {
    pool: PostgresPool;
    commands?: readonly ApprovedVerificationCommand[];
  }) {
    this.pool = input.pool;
    this.commands = new Map((input.commands ?? []).map((command) => [
      command.reference,
      command,
    ]));
  }

  async run(
    entry: AcceptanceVerificationEntry,
    scope: GoalVerificationScope,
    signal?: AbortSignal,
  ) {
    if (entry.strategy.type === "manual") {
      throw new Error("Manual strategies are handled by GoalVerificationService");
    }
    if (entry.strategy.type === "command") {
      const command = this.commands.get(entry.strategy.reference);
      if (!command) throw new Error("Verification command is not approved");
      const result = await executeCommand(command, signal);
      return {
        status: result.exitCode === 0 ? "passed" as const : "failed" as const,
        evidenceRefs: [
          `verification-command:${entry.strategy.reference}:exit:${result.exitCode ?? "signal"}`,
        ],
        summary: result.exitCode === 0
          ? "Approved verification command exited with code 0."
          : `Approved verification command failed with exit code ${result.exitCode ?? "signal"}.`,
        durationMs: result.durationMs,
      };
    }
    if (entry.strategy.type === "artifact") {
      const byDigest = entry.strategy.reference.startsWith("artifact:sha256:");
      const value = entry.strategy.reference.replace(
        byDigest ? "artifact:sha256:" : "artifact:",
        "",
      );
      const result = await this.pool.query(
        `SELECT 1 FROM artifact_objects object
          JOIN evidence evidence
            ON evidence.organization_id=object.organization_id
           AND evidence.project_id=object.project_id
           AND evidence.digest=object.digest
          WHERE evidence.organization_id=$1 AND evidence.project_id=$2
            AND evidence.goal_id=$3
            AND ${byDigest ? "object.digest" : "object.id::text"}=$4 LIMIT 1`,
        [scope.organizationId, scope.projectId, scope.goalId, value],
      );
      return {
        status: result.rowCount === 1 ? "passed" as const : "failed" as const,
        evidenceRefs: result.rowCount === 1 ? [entry.strategy.reference] : [],
        summary: result.rowCount === 1
          ? "Immutable Artifact reference and scope were verified."
          : "Immutable Artifact reference was missing from the Goal scope.",
        durationMs: 0,
      };
    }
    if (!builtInVerificationQueries.includes(
      entry.strategy.reference as (typeof builtInVerificationQueries)[number],
    )) {
      throw new Error("Verification query is not approved");
    }
    const queryReference = entry.strategy.reference as
      (typeof builtInVerificationQueries)[number];
    const conditions: Record<(typeof builtInVerificationQueries)[number], string> = {
      "query:issues:completed":
        "SELECT count(*)::integer AS total,count(*) FILTER (WHERE status<>'completed')::integer AS missing FROM issues WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 AND status<>'cancelled'",
      "query:reviews:approved":
        `SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM reviews review WHERE review.issue_id=issue.id
              AND review.verdict='approved'
          ))::integer AS missing
         FROM issues issue WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
           AND status='completed'`,
      "query:delivery:ready":
        `SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE candidate.state NOT IN ('local_ready','landed'))::integer AS missing
         FROM delivery_candidates candidate
         WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3`,
    };
    const result = await this.pool.query<{ total: number; missing: number }>(
      conditions[queryReference],
      [scope.organizationId, scope.projectId, scope.goalId],
    );
    const total = Number(result.rows[0]?.total ?? 0);
    const missing = Number(result.rows[0]?.missing ?? 0);
    const passed = total > 0 && missing === 0;
    return {
      status: passed ? "passed" as const : "failed" as const,
      evidenceRefs: [
        `verification-query:${entry.strategy.reference}:total:${total}:missing:${missing}`,
      ],
      summary: passed
        ? `Approved query proved all ${total} records satisfy the condition.`
        : `Approved query found ${missing} missing results across ${total} records.`,
      durationMs: 0,
    };
  }
}
