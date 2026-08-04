import assert from "node:assert/strict";
import test from "node:test";

import {
  AutoDevCliExecutionGateway,
  ExecutionPolicyError,
} from "../app/control-plane/adapters/autodev-cli-execution-gateway.ts";

test("P7 gateway uses fixed argument arrays, minimal env, and redacts secrets", async () => {
  const calls = [];
  const gateway = new AutoDevCliExecutionGateway({
    pythonExecutable: "/usr/bin/python3",
    projectConfigPath: "/srv/autodev/project.yaml",
    networkWrapper: {
      executable: "/usr/local/bin/network-sandbox",
      arguments: ["--deny-network", "--"],
    },
    environment: { PATH: "/usr/bin", SHOULD_NOT_LEAK: "private" },
    secretResolver: async (names) => Object.fromEntries(
      names.map((name) => [name, "top-secret-value"]),
    ),
    processRunner: async (request) => {
      calls.push(request);
      return {
        exitCode: 0,
        stdout: '{"ok":true,"status":"done","message":"top-secret-value"}',
        stderr: "",
      };
    },
  });
  const result = await gateway.start({
    externalTaskId: "H-001",
    externalRunId: "cp-run-1-a1",
    selectedSecrets: ["AUTODEV_API_TOKEN"],
    timeoutMs: 10_000,
  });
  assert.equal(calls[0].executable, "/usr/local/bin/network-sandbox");
  assert.deepEqual(calls[0].arguments, [
    "--deny-network", "--", "/usr/bin/python3", "-m", "autodev",
    "run-one", "--project", "/srv/autodev/project.yaml", "--task", "H-001",
    "--run-id", "cp-run-1-a1", "--json",
  ]);
  assert.deepEqual(Object.keys(calls[0].environment).sort(), [
    "AUTODEV_API_TOKEN", "PATH",
  ]);
  assert.equal(calls[0].shell, false);
  assert.doesNotMatch(result.message, /top-secret-value/);
  assert.match(result.message, /\[REDACTED\]/);
});

test("P7 gateway rejects malicious identifiers and missing network enforcement", async () => {
  const unsafe = new AutoDevCliExecutionGateway({
    pythonExecutable: "/usr/bin/python3",
    projectConfigPath: "/srv/autodev/project.yaml",
    environment: { PATH: "/usr/bin" },
    secretResolver: async () => ({}),
    processRunner: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
  });
  await assert.rejects(
    () => unsafe.start({
      externalTaskId: "H-001; rm -rf /",
      externalRunId: "run-1",
      selectedSecrets: [],
      timeoutMs: 1000,
    }),
    ExecutionPolicyError,
  );
  await assert.rejects(
    () => unsafe.start({
      externalTaskId: "H-001",
      externalRunId: "run-1",
      selectedSecrets: [],
      timeoutMs: 1000,
    }),
    /network/i,
  );
});

test("P7 gateway reports timeout and fails closed on workspace cleanup errors", async () => {
  const base = {
    pythonExecutable: "/usr/bin/python3",
    projectConfigPath: "/srv/autodev/project.yaml",
    trustedRunnerEnforcesNetwork: true,
    environment: { PATH: "/usr/bin" },
    secretResolver: async () => ({}),
  };
  const timedOut = new AutoDevCliExecutionGateway({
    ...base,
    workspaceManager: {
      async create() { return "/tmp/p7-timeout"; },
      async cleanup() {},
    },
    processRunner: async () => ({
      exitCode: 1,
      stdout: '{"status":"builder_running","message":"timed out"}',
      stderr: "",
      timedOut: true,
    }),
  });
  const timeoutResult = await timedOut.start({
    externalTaskId: "H-001", externalRunId: "timeout-run",
    selectedSecrets: [], timeoutMs: 1,
  });
  assert.equal(timeoutResult.state, "failed");

  const cleanupFailure = new AutoDevCliExecutionGateway({
    ...base,
    workspaceManager: {
      async create() { return "/tmp/p7-cleanup"; },
      async cleanup() { throw new Error("private path detail"); },
    },
    processRunner: async () => ({ exitCode: 0, stdout: '{"status":"done"}', stderr: "" }),
  });
  await assert.rejects(
    () => cleanupFailure.start({
      externalTaskId: "H-001", externalRunId: "cleanup-run",
      selectedSecrets: [], timeoutMs: 1000,
    }),
    (error) => error instanceof ExecutionPolicyError &&
      error.message === "Execution workspace cleanup failed",
  );
});
