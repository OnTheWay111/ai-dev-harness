import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExecutionGatewayPort,
  ExecutionStartRequest,
  ExternalExecutionState,
  ExternalExecutionStatus,
} from "../ports/execution-gateway-port.ts";

const SAFE_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;

export class ExecutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionPolicyError";
  }
}

export interface ProcessRequest {
  executable: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  shell: false;
  timeoutMs: number;
  cancellationKey: string;
  workingDirectory: string;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export interface AutoDevCliExecutionGatewayOptions {
  pythonExecutable: string;
  projectConfigPath: string;
  networkWrapper?: {
    executable: string;
    arguments: readonly string[];
  };
  trustedRunnerEnforcesNetwork?: boolean;
  environment: Readonly<Record<string, string | undefined>>;
  secretResolver: (
    names: readonly string[],
  ) => Promise<Readonly<Record<string, string>>>;
  processRunner?: ProcessRunner;
  workspaceManager?: {
    create(): Promise<string>;
    cleanup(path: string): Promise<void>;
  };
}

function safeEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] =>
      SAFE_ENVIRONMENT_KEYS.has(entry[0]) && typeof entry[1] === "string"
    ),
  );
}

function validateExecutable(value: string, label: string): string {
  if (!value.startsWith("/") || value.includes("\0")) {
    throw new ExecutionPolicyError(`${label} must be an absolute executable path`);
  }
  return value;
}

function validateIdentifier(value: string, label: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new ExecutionPolicyError(`${label} is invalid`);
  }
  return value;
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets.filter((item) => item.length > 0)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function externalState(value: string): ExternalExecutionState {
  const status = value.toLowerCase();
  if (["done", "completed", "succeeded", "loop_complete"].includes(status)) {
    return "succeeded";
  }
  if (["failed", "error", "blocked", "system_error"].includes(status)) {
    return "failed";
  }
  if (["cancelled", "canceled", "stopped"].includes(status)) return "cancelled";
  if (["created", "starting"].includes(status)) return "starting";
  if (status) return "running";
  return "unknown";
}

function parseStatus(
  externalRunId: string,
  result: ProcessResult,
  secretValues: readonly string[],
): ExternalExecutionStatus {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    if (result.exitCode === 0) {
      throw new ExecutionPolicyError("AutoDev returned malformed machine-readable output");
    }
  }
  const status = String(payload.status ?? (result.exitCode === 0 ? "running" : "failed"));
  const message = redact(
    String(payload.message ?? result.stderr ?? result.stdout ?? ""),
    secretValues,
  );
  return {
    externalRunId,
    state: result.timedOut ? "failed" : externalState(status),
    phase: String(payload.phase ?? status),
    message,
  };
}

export class AutoDevCliExecutionGateway implements ExecutionGatewayPort {
  private readonly options: AutoDevCliExecutionGatewayOptions;
  private readonly runner: ProcessRunner;
  private readonly customRunner: boolean;
  private readonly workspaceManager: {
    create(): Promise<string>;
    cleanup(path: string): Promise<void>;
  };
  private readonly active = new Map<string, ChildProcess>();
  private readonly completed = new Map<string, ExternalExecutionStatus>();

  constructor(options: AutoDevCliExecutionGatewayOptions) {
    this.options = options;
    validateExecutable(options.pythonExecutable, "Python executable");
    if (!options.projectConfigPath.startsWith("/") || options.projectConfigPath.includes("\0")) {
      throw new ExecutionPolicyError("AutoDev project config must be an absolute path");
    }
    if (options.networkWrapper) {
      validateExecutable(options.networkWrapper.executable, "Network wrapper");
      if (options.networkWrapper.arguments.some((value) => value.includes("\0"))) {
        throw new ExecutionPolicyError("Network wrapper arguments are invalid");
      }
    }
    this.customRunner = options.processRunner !== undefined;
    this.workspaceManager = options.workspaceManager ?? {
      create: async () => await mkdtemp(join(tmpdir(), "ai-dev-execution-")),
      cleanup: async (path) => await rm(path, { recursive: true, force: true }),
    };
    this.runner = options.processRunner ?? ((request) => this.runProcess(request));
  }

  async start(request: ExecutionStartRequest): Promise<ExternalExecutionStatus> {
    validateIdentifier(request.externalTaskId, "External task id");
    validateIdentifier(request.externalRunId, "External run id");
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) {
      throw new ExecutionPolicyError("Execution timeout must be a positive integer");
    }
    if (!this.options.networkWrapper && !this.options.trustedRunnerEnforcesNetwork) {
      throw new ExecutionPolicyError("A network enforcement boundary is required");
    }
    const secretNames = [...new Set(request.selectedSecrets)];
    if (secretNames.some((name) => !SECRET_NAME_PATTERN.test(name))) {
      throw new ExecutionPolicyError("Secret selectors must be explicit environment names");
    }
    const secrets = await this.options.secretResolver(secretNames);
    if (Object.keys(secrets).some((name) => !secretNames.includes(name))) {
      throw new ExecutionPolicyError("Secret resolver returned an unrequested value");
    }
    const environment = {
      ...safeEnvironment(this.options.environment),
      ...Object.fromEntries(secretNames.map((name) => {
        const value = secrets[name];
        if (!value) throw new ExecutionPolicyError(`Required secret ${name} is unavailable`);
        return [name, value];
      })),
    };
    const autoDevArguments = [
      "-m",
      "autodev",
      "run-one",
      "--project",
      this.options.projectConfigPath,
      "--task",
      request.externalTaskId,
      "--run-id",
      request.externalRunId,
      "--json",
    ];
    const executable = this.options.networkWrapper?.executable ??
      this.options.pythonExecutable;
    const arguments_ = this.options.networkWrapper
      ? [
          ...this.options.networkWrapper.arguments,
          this.options.pythonExecutable,
          ...autoDevArguments,
        ]
      : autoDevArguments;
    const workingDirectory = await this.workspaceManager.create();
    if (!workingDirectory.startsWith("/") || workingDirectory.includes("\0")) {
      throw new ExecutionPolicyError("Execution working directory is invalid");
    }
    const processRequest: ProcessRequest = {
      executable,
      arguments: arguments_,
      environment,
      shell: false,
      timeoutMs: request.timeoutMs,
      cancellationKey: request.externalRunId,
      workingDirectory,
    };
    if (!this.customRunner) {
      this.launchProcess(processRequest, Object.values(secrets));
      return {
        externalRunId: request.externalRunId,
        state: "starting",
        phase: "starting",
        message: "AutoDev process launched",
      };
    }
    let result: ProcessResult;
    try {
      result = await this.runner(processRequest);
    } finally {
      try {
        await this.workspaceManager.cleanup(workingDirectory);
      } catch {
        throw new ExecutionPolicyError("Execution workspace cleanup failed");
      }
    }
    return parseStatus(request.externalRunId, result, Object.values(secrets));
  }

  async inspect(externalRunId: string): Promise<ExternalExecutionStatus | null> {
    validateIdentifier(externalRunId, "External run id");
    const completed = this.completed.get(externalRunId);
    if (completed) return structuredClone(completed);
    if (!this.options.networkWrapper && !this.options.trustedRunnerEnforcesNetwork) {
      throw new ExecutionPolicyError("A network enforcement boundary is required");
    }
    const autoDevArguments = [
      "-m", "autodev", "status", "--project", this.options.projectConfigPath,
      "--run-id", externalRunId, "--json",
    ];
    const result = await this.runner({
      executable: this.options.networkWrapper?.executable ?? this.options.pythonExecutable,
      arguments: this.options.networkWrapper
        ? [
            ...this.options.networkWrapper.arguments,
            this.options.pythonExecutable,
            ...autoDevArguments,
          ]
        : autoDevArguments,
      environment: safeEnvironment(this.options.environment),
      shell: false,
      timeoutMs: 30_000,
      cancellationKey: `inspect:${externalRunId}`,
      workingDirectory: tmpdir(),
    });
    if (result.exitCode !== 0 && /not found|no AutoDev runs/i.test(result.stderr)) {
      return null;
    }
    return parseStatus(externalRunId, result, []);
  }

  async cancel(externalRunId: string): Promise<void> {
    validateIdentifier(externalRunId, "External run id");
    const child = this.active.get(externalRunId);
    if (!child) return;
    child.kill("SIGTERM");
  }

  private async runProcess(request: ProcessRequest): Promise<ProcessResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.arguments], {
        env: { ...request.environment } as NodeJS.ProcessEnv,
        cwd: request.workingDirectory,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.active.set(request.cancellationKey, child);
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let timedOut = false;
      const append = (current: Buffer, chunk: Buffer): Buffer =>
        Buffer.concat([current, chunk]).subarray(0, OUTPUT_LIMIT_BYTES);
      child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", reject);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 2_000).unref();
      }, request.timeoutMs);
      timer.unref();
      child.once("close", (code) => {
        clearTimeout(timer);
        this.active.delete(request.cancellationKey);
        resolve({
          exitCode: code ?? 1,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timedOut,
        });
      });
    });
  }

  private launchProcess(
    request: ProcessRequest,
    secrets: readonly string[],
  ): void {
    const child = spawn(request.executable, [...request.arguments], {
      env: { ...request.environment } as NodeJS.ProcessEnv,
      cwd: request.workingDirectory,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.active.set(request.cancellationKey, child);
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timedOut = false;
    const append = (current: Buffer, chunk: Buffer): Buffer =>
      Buffer.concat([current, chunk]).subarray(0, OUTPUT_LIMIT_BYTES);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      this.active.delete(request.cancellationKey);
      this.completed.set(request.cancellationKey, {
        externalRunId: request.cancellationKey,
        state: "failed",
        phase: "launch",
        message: redact(error.message, secrets),
      });
      void this.workspaceManager.cleanup(request.workingDirectory).catch(() => undefined);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000).unref();
    }, request.timeoutMs);
    timer.unref();
    child.once("close", (code) => {
      clearTimeout(timer);
      this.active.delete(request.cancellationKey);
      try {
        this.completed.set(request.cancellationKey, parseStatus(
          request.cancellationKey,
          {
            exitCode: code ?? 1,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            timedOut,
          },
          secrets,
        ));
      } catch (error) {
        this.completed.set(request.cancellationKey, {
          externalRunId: request.cancellationKey,
          state: "failed",
          phase: "result",
          message: redact(
            error instanceof Error ? error.message : "AutoDev result invalid",
            secrets,
          ),
        });
      }
      void this.workspaceManager.cleanup(request.workingDirectory).catch(() => {
        this.completed.set(request.cancellationKey, {
          externalRunId: request.cancellationKey,
          state: "failed",
          phase: "cleanup",
          message: "Execution workspace cleanup failed",
        });
      });
    });
  }
}
