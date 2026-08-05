import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runPlannerProcess,
  type PlannerProcessRunner,
} from "./codex-planner-adapter.ts";
import { goalVerifierOutputSchema } from
  "../domain/goal-verification.ts";
import type {
  GoalVerifierPort,
} from "../ports/goal-verifier-port.ts";

function minimalEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    [
      "PATH", "HOME", "CODEX_HOME", "HTTPS_PROXY", "HTTP_PROXY",
      "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
    ].flatMap((name) => source[name] ? [[name, source[name] as string]] : []),
  );
}

export class CodexGoalVerifierAdapter implements GoalVerifierPort {
  private readonly command: string;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxContextBytes: number;
  private readonly environment: Record<string, string>;
  private readonly runner: PlannerProcessRunner;

  constructor(input: {
    command?: string;
    model?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    maxContextBytes?: number;
    environment?: Readonly<Record<string, string | undefined>>;
    runner?: PlannerProcessRunner;
  } = {}) {
    this.command = input.command ?? "codex";
    this.model = input.model;
    this.timeoutMs = input.timeoutMs ?? 120_000;
    this.maxOutputBytes = input.maxOutputBytes ?? 256 * 1024;
    this.maxContextBytes = input.maxContextBytes ?? 128 * 1024;
    this.environment = minimalEnvironment(input.environment ?? process.env);
    this.runner = input.runner ?? runPlannerProcess;
  }

  async verify(request: Parameters<GoalVerifierPort["verify"]>[0]) {
    if (!request.session.fresh || request.session.access !== "read_only" ||
      request.session.canModifyCode) {
      throw new Error("Goal Verifier requires a fresh read-only session");
    }
    const context = JSON.stringify({
      goal: {
        id: request.goal.id,
        version: request.goal.version,
        title: request.goal.title,
        problemStatement: request.goal.problemStatement,
        desiredOutcome: request.goal.desiredOutcome,
        acceptanceCriteria: request.goal.acceptanceCriteria,
        nonGoals: request.goal.nonGoals,
        constraints: request.goal.constraints,
      },
      verificationPlan: {
        id: request.plan.id,
        digest: request.plan.digest,
        entries: request.plan.entries,
      },
      deterministicResults: request.deterministicResults,
      session: request.session,
    });
    if (Buffer.byteLength(context) > this.maxContextBytes) {
      throw new Error("Goal Verifier context budget exceeded");
    }
    const directory = await mkdtemp(join(tmpdir(), "ai-dev-harness-verifier-"));
    const schemaPath = join(directory, "output-schema.json");
    const outputPath = join(directory, "last-message.json");
    try {
      await writeFile(schemaPath, JSON.stringify(goalVerifierOutputSchema), {
        encoding: "utf8",
        mode: 0o600,
      });
      const args = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
      ];
      if (this.model) args.push("--model", this.model);
      args.push("-");
      const result = await this.runner({
        command: this.command,
        args,
        cwd: directory,
        environment: this.environment,
        stdin: [
          "You are an independent Goal Verifier in a fresh read-only session.",
          "Evaluate every AcceptanceCriterion, every non-goal, every constraint, evidence coverage, and regression risk.",
          "You cannot modify code, create approvals, or infer success from Issue closure.",
          "Cite only supplied immutable evidence references and return JSON matching the schema.",
          `<verification-context>${context}</verification-context>`,
        ].join("\n"),
        outputPath,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      });
      if (result.timedOut || result.outputLimitExceeded || result.exitCode !== 0) {
        throw new Error("Goal Verifier process failed closed");
      }
      const metadata = await stat(outputPath);
      if (metadata.size > this.maxOutputBytes) {
        throw new Error("Goal Verifier output budget exceeded");
      }
      return JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
