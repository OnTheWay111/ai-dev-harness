import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPlannerContextPacket,
  PlannerExecutionError,
  type PlannerDraft,
  type PlannerPort,
  type PlannerRequest,
} from "../ports/planner-port.ts";

const allowedEnvironmentNames = [
  "PATH",
  "HOME",
  "CODEX_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
] as const;

export interface PlannerProcessRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  stdin: string;
  outputPath: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface PlannerProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  outputLimitExceeded?: boolean;
}

export type PlannerProcessRunner = (
  request: PlannerProcessRequest,
) => Promise<PlannerProcessResult>;

export interface PlannerLogEvent {
  event: "planner.completed" | "planner.failed";
  plannerRunId: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

function minimumEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment = Object.fromEntries(allowedEnvironmentNames.flatMap((name) => {
    const value = source[name];
    return value ? [[name, value]] : [];
  }));
  if (source.NVM_BIN && environment.PATH) {
    environment.PATH = `${source.NVM_BIN}:${environment.PATH}`;
  }
  return environment;
}

export const runPlannerProcess: PlannerProcessRunner = async (request) =>
  await new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.environment as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    const account = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (stream === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > request.maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => account("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => account("stderr", chunk));
    child.once("error", reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
    child.once("close", (exitCode: number | null) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        timedOut,
        stdoutBytes,
        stderrBytes,
        outputLimitExceeded,
      });
    });
    child.stdin.end(request.stdin);
  });

export interface CodexPlannerOptions {
  command?: string;
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxContextBytes?: number;
  environment?: Readonly<Record<string, string | undefined>>;
  runner?: PlannerProcessRunner;
  logger?: (event: PlannerLogEvent) => void;
}

export class CodexPlannerAdapter implements PlannerPort {
  private readonly command: string;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxContextBytes: number;
  private readonly environment: Record<string, string>;
  private readonly runner: PlannerProcessRunner;
  private readonly logger: (event: PlannerLogEvent) => void;

  constructor(options: CodexPlannerOptions = {}) {
    this.command = options.command ?? "codex";
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    this.maxContextBytes = options.maxContextBytes ?? 64 * 1024;
    this.environment = minimumEnvironment(options.environment ?? process.env);
    this.runner = options.runner ?? runPlannerProcess;
    this.logger = options.logger ?? (() => undefined);
  }

  async plan<T = unknown>(request: PlannerRequest): Promise<PlannerDraft<T>> {
    const plannerRunId = crypto.randomUUID();
    const startedAt = Date.now();
    const directory = await mkdtemp(join(tmpdir(), "ai-dev-harness-planner-"));
    const schemaPath = join(directory, "output-schema.json");
    const outputPath = join(directory, "last-message.json");
    let result: PlannerProcessResult = {
      exitCode: null,
      timedOut: false,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    try {
      const packet = buildPlannerContextPacket(request.goal);
      const context = JSON.stringify(packet);
      if (Buffer.byteLength(context) > this.maxContextBytes) {
        throw new PlannerExecutionError("planner_budget_exceeded");
      }
      await writeFile(schemaPath, JSON.stringify(request.outputSchema), {
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
      result = await this.runner({
        command: this.command,
        args,
        cwd: directory,
        environment: this.environment,
        stdin: [
          "You are the Goal Planner. Analyze only the supplied Goal context.",
          "Return a JSON draft matching the output schema.",
          "Do not approve business decisions and do not inspect any repository.",
          `<goal-context>${context}</goal-context>`,
        ].join("\n"),
        outputPath,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      });
      if (result.timedOut) throw new PlannerExecutionError("planner_timeout");
      if (result.outputLimitExceeded) {
        throw new PlannerExecutionError("planner_budget_exceeded");
      }
      if (result.exitCode !== 0) throw new PlannerExecutionError("planner_failed");
      const metadata = await stat(outputPath);
      if (metadata.size > this.maxOutputBytes) {
        throw new PlannerExecutionError("planner_budget_exceeded");
      }
      let output: T;
      try {
        output = JSON.parse(await readFile(outputPath, "utf8")) as T;
      } catch {
        throw new PlannerExecutionError("planner_invalid_output");
      }
      this.logger({
        event: "planner.completed",
        plannerRunId,
        durationMs: Date.now() - startedAt,
        ...result,
      });
      return {
        status: "draft",
        plannerRunId,
        goalId: packet.goalId,
        sourceGoalVersion: packet.goalVersion,
        output,
      };
    } catch (error) {
      this.logger({
        event: "planner.failed",
        plannerRunId,
        durationMs: Date.now() - startedAt,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
      });
      if (error instanceof PlannerExecutionError) throw error;
      throw new PlannerExecutionError("planner_failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
