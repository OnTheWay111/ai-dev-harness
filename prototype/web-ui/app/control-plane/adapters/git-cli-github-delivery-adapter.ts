import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type { CredentialLease } from
  "../ports/credential-broker-port.ts";
import type {
  CommitReceipt,
  GitDeliveryPort,
} from "../ports/git-delivery-port.ts";
import type {
  LandingReceipt,
  PullRequestReceipt,
  PushReceipt,
} from "../domain/delivery.ts";

const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OUTPUT_LIMIT = 1024 * 1024;

interface GitProcessRequest {
  executable: string;
  arguments: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
  secretValues: readonly string[];
}

interface GitProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type GitProcessRunner = (
  request: GitProcessRequest,
) => Promise<GitProcessResult>;

interface GitHubRepositoryTarget {
  owner: string;
  name: string;
  apiBaseUrl?: string;
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets.filter(Boolean)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/(authorization:\s*(?:basic|bearer)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\/(?:Users|home)\/[^\s]+/g, "[REDACTED_PATH]")
    .replace(/\/tmp\/[^\s]+/g, "[REDACTED_PATH]");
}

function assertLease(
  credential: CredentialLease,
  scope: "contents:write" | "pull_requests:write",
): void {
  const expiresAt = Date.parse(credential.expiresAt);
  if (!credential.token || !credential.scopes.includes(scope) ||
    !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Git credential lease is expired or under-scoped");
  }
}

function assertTarget(input: {
  worktreePath?: string;
  branch?: string;
  commitSha?: string;
  baselineSha?: string;
}): void {
  if (input.worktreePath !== undefined &&
    (!isAbsolute(input.worktreePath) || input.worktreePath.includes("\0"))) {
    throw new Error("Git worktree path is invalid");
  }
  if (input.branch !== undefined && !BRANCH.test(input.branch)) {
    throw new Error("Git branch is invalid");
  }
  if (input.commitSha !== undefined && !SHA.test(input.commitSha) ||
    input.baselineSha !== undefined && !SHA.test(input.baselineSha)) {
    throw new Error("Git commit identity is invalid");
  }
}

export class GitCliGitHubDeliveryAdapter implements GitDeliveryPort {
  private readonly gitExecutable: string;
  private readonly runner: GitProcessRunner;
  private readonly fetcher: typeof fetch;
  private readonly repositoryResolver: (
    repositoryId: string,
  ) => Promise<GitHubRepositoryTarget>;
  private readonly clock: () => Date;

  constructor(input: {
    gitExecutable: string;
    processRunner?: GitProcessRunner;
    fetcher?: typeof fetch;
    repositoryResolver?: (
      repositoryId: string,
    ) => Promise<GitHubRepositoryTarget>;
    clock?: () => Date;
  }) {
    if (!isAbsolute(input.gitExecutable) || input.gitExecutable.includes("\0")) {
      throw new Error("Git executable must be an absolute path");
    }
    this.gitExecutable = input.gitExecutable;
    this.runner = input.processRunner ?? ((request) => this.run(request));
    this.fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis);
    this.repositoryResolver = input.repositoryResolver ?? (async () => {
      throw new Error("GitHub repository mapping is unavailable");
    });
    this.clock = input.clock ?? (() => new Date());
  }

  async createCommit(input: {
    operationKey: string;
    worktreePath: string;
    branch: string;
    baselineSha: string;
    message: string;
  }): Promise<CommitReceipt> {
    assertTarget(input);
    if (!input.message.trim() || input.message.length > 4_000 ||
      /[\0\r]/.test(input.message)) {
      throw new Error("Git commit message is invalid");
    }
    const currentBranch = (await this.git(
      input.worktreePath,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
    )).stdout.trim();
    if (currentBranch !== input.branch) {
      throw new Error("Git worktree is not on the policy-authorized issue branch");
    }
    const head = (await this.git(
      input.worktreePath,
      ["rev-parse", "HEAD"],
    )).stdout.trim();
    const status = (await this.git(
      input.worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
    )).stdout;
    if (head !== input.baselineSha) {
      if (status.trim()) {
        throw new Error("Git candidate moved beyond its baseline with uncommitted changes");
      }
      const message = (await this.git(
        input.worktreePath,
        ["log", "-1", "--format=%B", "HEAD"],
      )).stdout.trim();
      const parent = (await this.git(
        input.worktreePath,
        ["rev-parse", "HEAD^"],
      )).stdout.trim();
      if (parent !== input.baselineSha || message !== input.message.trim()) {
        throw new Error("Git candidate contains an unrecognized prior commit");
      }
      return {
        commitSha: head,
        summary: "Existing idempotent commit",
      };
    }
    if (!status.trim()) throw new Error("Verified candidate has no changes to commit");
    await this.git(input.worktreePath, ["add", "--all"]);
    await this.git(
      input.worktreePath,
      ["commit", "--no-gpg-sign", "-m", input.message.trim()],
      {
        GIT_AUTHOR_NAME: "AI Dev Harness",
        GIT_AUTHOR_EMAIL: "ai-dev-harness@localhost.invalid",
        GIT_COMMITTER_NAME: "AI Dev Harness",
        GIT_COMMITTER_EMAIL: "ai-dev-harness@localhost.invalid",
      },
    );
    const commitSha = (await this.git(
      input.worktreePath,
      ["rev-parse", "HEAD"],
    )).stdout.trim();
    if (!SHA.test(commitSha)) throw new Error("Git returned an invalid commit SHA");
    const summary = (await this.git(
      input.worktreePath,
      ["show", "--stat", "--oneline", "--format=%h:%s", "HEAD"],
    )).stdout.trim().slice(0, 4_000);
    return { commitSha, summary };
  }

  async pushBranch(input: {
    operationKey: string;
    worktreePath: string;
    branch: string;
    commitSha: string;
    credential: CredentialLease;
  }): Promise<PushReceipt> {
    assertTarget(input);
    assertLease(input.credential, "contents:write");
    const resolved = (await this.git(
      input.worktreePath,
      ["rev-parse", `${input.commitSha}^{commit}`],
    )).stdout.trim();
    if (resolved !== input.commitSha) {
      throw new Error("Push commit is not present in the isolated worktree");
    }
    const authorization = Buffer.from(
      `x-access-token:${input.credential.token}`,
      "utf8",
    ).toString("base64");
    await this.git(
      input.worktreePath,
      [
        "push", "--porcelain", "origin",
        `${input.commitSha}:refs/heads/${input.branch}`,
      ],
      {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
      },
      [input.credential.token, authorization],
    );
    const receiptId = createHash("sha256")
      .update(`${input.operationKey}\0${input.branch}\0${input.commitSha}`)
      .digest("hex");
    return {
      receiptId,
      remoteName: "origin",
      remoteBranch: input.branch,
      commitSha: input.commitSha,
      pushedAt: this.clock().toISOString(),
    };
  }

  async openPullRequest(input: {
    operationKey: string;
    repositoryId: string;
    branch: string;
    baselineBranch: string;
    commitSha: string;
    credential: CredentialLease;
  }): Promise<PullRequestReceipt> {
    assertTarget(input);
    assertLease(input.credential, "pull_requests:write");
    const repository = await this.repositoryResolver(input.repositoryId);
    const base = this.apiBase(repository);
    const existing = await this.github<unknown[]>(
      `${base}/pulls?state=open&head=${encodeURIComponent(`${repository.owner}:${input.branch}`)}&base=${encodeURIComponent(input.baselineBranch)}`,
      { method: "GET" },
      input.credential,
    );
    const prior = existing.find((item) => {
      const row = item as Record<string, unknown>;
      const head = row.head as Record<string, unknown> | undefined;
      return head?.sha === input.commitSha;
    }) as Record<string, unknown> | undefined;
    const response = prior ?? await this.github<Record<string, unknown>>(
      `${base}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `AutoDev: ${input.branch}`,
          head: input.branch,
          base: input.baselineBranch,
          body: `Automated candidate for commit ${input.commitSha}. Merge remains gate-controlled.`,
        }),
      },
      input.credential,
    );
    this.assertPullRequestTarget(
      response,
      input.commitSha,
      input.branch,
      input.baselineBranch,
    );
    return this.pullRequestReceipt(response, input.branch, input.baselineBranch);
  }

  async mergePullRequest(input: {
    operationKey: string;
    repositoryId: string;
    pullRequest: PullRequestReceipt;
    expectedCommitSha: string;
    credential: CredentialLease;
  }): Promise<LandingReceipt> {
    assertTarget({ commitSha: input.expectedCommitSha });
    assertLease(input.credential, "pull_requests:write");
    if (!/^\d+$/.test(input.pullRequest.externalId)) {
      throw new Error("GitHub pull request identity is invalid");
    }
    const repository = await this.repositoryResolver(input.repositoryId);
    const url = `${this.apiBase(repository)}/pulls/${input.pullRequest.externalId}`;
    const current = await this.github<Record<string, unknown>>(
      url,
      { method: "GET" },
      input.credential,
    );
    const head = current.head as Record<string, unknown> | undefined;
    if (head?.sha !== input.expectedCommitSha) {
      throw new Error("Pull request head changed after independent Review");
    }
    if (current.merged === true && typeof current.merge_commit_sha === "string" &&
      SHA.test(current.merge_commit_sha)) {
      return {
        externalId: input.pullRequest.externalId,
        landingCommitSha: current.merge_commit_sha,
        landedAt: String(current.merged_at ?? this.clock().toISOString()),
      };
    }
    const merged = await this.github<Record<string, unknown>>(
      `${url}/merge`,
      {
        method: "PUT",
        body: JSON.stringify({
          sha: input.expectedCommitSha,
          merge_method: "squash",
        }),
      },
      input.credential,
    );
    if (merged.merged !== true || typeof merged.sha !== "string" ||
      !SHA.test(merged.sha)) {
      throw new Error("GitHub rejected the gate-controlled Landing operation");
    }
    return {
      externalId: input.pullRequest.externalId,
      landingCommitSha: merged.sha,
      landedAt: this.clock().toISOString(),
    };
  }

  private apiBase(repository: GitHubRepositoryTarget): string {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(repository.owner) ||
      !/^[A-Za-z0-9_.-]{1,200}$/.test(repository.name)) {
      throw new Error("GitHub repository mapping is invalid");
    }
    const api = (repository.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    const parsed = new URL(api);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.search || parsed.hash) {
      throw new Error("GitHub API must use a clean HTTPS URL");
    }
    return `${api}/repos/${repository.owner}/${repository.name}`;
  }

  private assertPullRequestTarget(
    response: Record<string, unknown>,
    commitSha: string,
    branch: string,
    baselineBranch: string,
  ): void {
    const head = response.head as Record<string, unknown> | undefined;
    const base = response.base as Record<string, unknown> | undefined;
    if (head?.sha !== commitSha || head.ref !== branch ||
      base?.ref !== baselineBranch) {
      throw new Error("Pull request target changed from the reviewed candidate");
    }
  }

  private pullRequestReceipt(
    response: Record<string, unknown>,
    branch: string,
    baselineBranch: string,
  ): PullRequestReceipt {
    const externalId = String(response.number ?? response.id ?? "");
    const url = String(response.html_url ?? "");
    if (!externalId || !url.startsWith("https://")) {
      throw new Error("GitHub returned an invalid pull request receipt");
    }
    return { externalId, url, headBranch: branch, baseBranch: baselineBranch };
  }

  private async github<T>(
    url: string,
    init: RequestInit,
    credential: CredentialLease,
  ): Promise<T> {
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub delivery request failed with HTTP ${response.status}`);
    }
    return await response.json() as T;
  }

  private async git(
    workingDirectory: string,
    arguments_: readonly string[],
    environment: Readonly<Record<string, string>> = {},
    secretValues: readonly string[] = [],
  ): Promise<GitProcessResult> {
    const result = await this.runner({
      executable: this.gitExecutable,
      arguments: arguments_,
      workingDirectory,
      environment,
      secretValues,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Git delivery command failed: ${redact(result.stderr || result.stdout, secretValues).slice(0, 1_000)}`,
      );
    }
    return {
      ...result,
      stdout: redact(result.stdout, secretValues),
      stderr: redact(result.stderr, secretValues),
    };
  }

  private async run(request: GitProcessRequest): Promise<GitProcessResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.arguments], {
        cwd: request.workingDirectory,
        env: { ...process.env, ...request.environment },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const append = (current: Buffer, chunk: Buffer) =>
        Buffer.concat([current, chunk]).subarray(0, OUTPUT_LIMIT);
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", reject);
      child.once("close", (code) => resolve({
        exitCode: code ?? 1,
        stdout: redact(stdout.toString("utf8"), request.secretValues),
        stderr: redact(stderr.toString("utf8"), request.secretValues),
      }));
    });
  }
}
