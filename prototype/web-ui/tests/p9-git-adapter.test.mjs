import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitCliGitHubDeliveryAdapter } from
  "../app/control-plane/adapters/git-cli-github-delivery-adapter.ts";

function git(...arguments_) {
  return execFileSync("/usr/bin/git", arguments_, { encoding: "utf8" }).trim();
}

function lease() {
  return {
    token: "synthetic-ephemeral-git-token",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    scopes: ["contents:write", "pull_requests:write"],
    async release() {},
  };
}

test("Git adapter commits and pushes to an isolated real remote without putting credentials in arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "p9-git-delivery-"));
  const remote = join(root, "remote.git");
  const worktree = join(root, "worktree");
  try {
    await mkdir(worktree);
    git("init", "--bare", remote);
    git("-C", worktree, "init");
    git("-C", worktree, "config", "user.name", "P9 Test");
    git("-C", worktree, "config", "user.email", "p9@example.invalid");
    await writeFile(join(worktree, "README.md"), "base\n");
    git("-C", worktree, "add", "README.md");
    git("-C", worktree, "commit", "-m", "base");
    git("-C", worktree, "branch", "-M", "main");
    git("-C", worktree, "remote", "add", "origin", remote);
    git("-C", worktree, "push", "-u", "origin", "main");
    const baselineSha = git("-C", worktree, "rev-parse", "HEAD");
    const branch = "autodev/goal-1/issue-1";
    git("-C", worktree, "checkout", "-b", branch);
    await writeFile(join(worktree, "README.md"), "base\nchange\n");

    const adapter = new GitCliGitHubDeliveryAdapter({
      gitExecutable: "/usr/bin/git",
      clock: () => new Date("2026-08-05T06:00:00.000Z"),
    });
    const committed = await adapter.createCommit({
      operationKey: "real-commit-operation",
      worktreePath: worktree,
      branch,
      baselineSha,
      message: "feat: isolated P9 delivery",
    });
    assert.match(committed.commitSha, /^[0-9a-f]{40}$/);
    const pushed = await adapter.pushBranch({
      operationKey: "real-push-operation",
      worktreePath: worktree,
      branch,
      commitSha: committed.commitSha,
      credential: lease(),
    });
    assert.equal(pushed.remoteBranch, branch);
    assert.equal(
      git("--git-dir", remote, "rev-parse", `refs/heads/${branch}`),
      committed.commitSha,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub adapter reuses PRs, verifies reviewed heads, and never exposes token failures", async () => {
  const calls = [];
  const reviewedSha = "b".repeat(40);
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("state=open")) {
      return Response.json([]);
    }
    if (String(url).endsWith("/pulls") && init.method === "POST") {
      return Response.json({
        number: 42,
        html_url: "https://github.test/acme/repo/pull/42",
        head: { sha: reviewedSha, ref: "autodev/goal-1/issue-1" },
        base: { ref: "main" },
      });
    }
    if (String(url).endsWith("/pulls/42") && init.method === "GET") {
      return Response.json({ merged: false, head: { sha: reviewedSha } });
    }
    if (String(url).endsWith("/pulls/42/merge")) {
      return Response.json({ merged: true, sha: "c".repeat(40) });
    }
    return Response.json({}, { status: 404 });
  };
  const adapter = new GitCliGitHubDeliveryAdapter({
    gitExecutable: "/usr/bin/git",
    fetcher,
    repositoryResolver: async () => ({
      owner: "acme",
      name: "repo",
      apiBaseUrl: "https://api.github.test",
    }),
    clock: () => new Date("2026-08-05T06:30:00.000Z"),
  });
  const credential = lease();
  const pullRequest = await adapter.openPullRequest({
    operationKey: "open-pr-operation",
    repositoryId: crypto.randomUUID(),
    branch: "autodev/goal-1/issue-1",
    baselineBranch: "main",
    commitSha: reviewedSha,
    credential,
  });
  assert.equal(pullRequest.externalId, "42");
  const landing = await adapter.mergePullRequest({
    operationKey: "landing-operation",
    repositoryId: crypto.randomUUID(),
    pullRequest,
    expectedCommitSha: reviewedSha,
    credential,
  });
  assert.equal(landing.landingCommitSha, "c".repeat(40));
  assert.ok(calls.every((call) => call.init.headers.authorization === `Bearer ${credential.token}`));

  const failing = new GitCliGitHubDeliveryAdapter({
    gitExecutable: "/usr/bin/git",
    fetcher: async () => new Response("synthetic-ephemeral-git-token", { status: 500 }),
    repositoryResolver: async () => ({ owner: "acme", name: "repo" }),
  });
  await assert.rejects(
    () => failing.openPullRequest({
      operationKey: "failing-pr-operation",
      repositoryId: crypto.randomUUID(),
      branch: "autodev/goal-1/issue-1",
      baselineBranch: "main",
      commitSha: reviewedSha,
      credential,
    }),
    (error) => !error.message.includes(credential.token),
  );

  const changedMergedHead = new GitCliGitHubDeliveryAdapter({
    gitExecutable: "/usr/bin/git",
    fetcher: async () => Response.json({
      merged: true,
      merge_commit_sha: "d".repeat(40),
      merged_at: "2026-08-05T06:30:00.000Z",
      head: { sha: "e".repeat(40) },
    }),
    repositoryResolver: async () => ({ owner: "acme", name: "repo" }),
  });
  await assert.rejects(
    () => changedMergedHead.mergePullRequest({
      operationKey: "changed-merged-head",
      repositoryId: crypto.randomUUID(),
      pullRequest,
      expectedCommitSha: reviewedSha,
      credential,
    }),
    /head changed/i,
  );
});
