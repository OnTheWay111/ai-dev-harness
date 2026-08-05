import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OidcConfig } from "../../auth/oidc-service.ts";
import { AutoDevCliExecutionGateway } from
  "../adapters/autodev-cli-execution-gateway.ts";
import { CodexGoalVerifierAdapter } from
  "../adapters/codex-goal-verifier-adapter.ts";
import { CodexPlannerAdapter } from
  "../adapters/codex-planner-adapter.ts";
import { FileSystemObjectStore } from
  "../adapters/filesystem-object-store.ts";
import { GitCliGitHubDeliveryAdapter } from
  "../adapters/git-cli-github-delivery-adapter.ts";
import { MemoryObjectStore } from
  "../adapters/memory-object-store.ts";
import { normalizeAutoDevRunEvent } from
  "../application/external-event-service.ts";
import { PlannerExecutionError } from "../ports/planner-port.ts";
import type {
  PlannerDraft,
  PlannerPort,
  PlannerRequest,
} from "../ports/planner-port.ts";
import type { GoalVerifierPort } from "../ports/goal-verifier-port.ts";
import type {
  AutoDevRunEventV1,
} from "../ports/execution-event-repository.ts";
import type {
  ExecutionGatewayPort,
  ExecutionStartRequest,
  ExternalExecutionStatus,
} from "../ports/execution-gateway-port.ts";
import type { GitDeliveryPort } from "../ports/git-delivery-port.ts";
import type {
  ImmutableObjectDescriptor,
  ImmutableObjectUpload,
  ObjectDownloadGrant,
  ObjectStorePort,
} from "../ports/object-store-port.ts";

export type P12FakeScenario =
  | "success"
  | "timeout"
  | "invalid_output"
  | "duplicate"
  | "out_of_order"
  | "partial_failure";

export type P12FakeEndpoint =
  | "codex.plan"
  | "codex.verify"
  | "autodev.start"
  | "autodev.inspect"
  | "autodev.events"
  | "git.createCommit"
  | "git.pushBranch"
  | "git.openPullRequest"
  | "git.mergePullRequest"
  | "objectStore.put"
  | "objectStore.read"
  | "oidc.discovery"
  | "oidc.token"
  | "oidc.jwks";

export interface P12RecordedContracts {
  schemaVersion: "harness.p12-recorded-contracts.v1";
  recordedAt: string;
  provenance: Readonly<Record<string, string>>;
  fixed: {
    now: string;
    organizationId: string;
    projectId: string;
    goalId: string;
    runId: string;
    issueId: string;
  };
  codex: {
    plannerOutput: unknown;
    verifierOutput: unknown;
  };
  autodev: {
    startStatus: ExternalExecutionStatus;
    events: readonly Readonly<Record<string, unknown>>[];
  };
  git: {
    commit: Awaited<ReturnType<GitDeliveryPort["createCommit"]>>;
    push: Awaited<ReturnType<GitDeliveryPort["pushBranch"]>>;
    pullRequest: Awaited<ReturnType<GitDeliveryPort["openPullRequest"]>>;
    landing: Awaited<ReturnType<GitDeliveryPort["mergePullRequest"]>>;
  };
  objectStore: {
    content: string;
    mediaType: string;
  };
  oidc: {
    issuer: string;
    clientId: string;
    subject: string;
    email: string;
    name: string;
  };
}

export class P12ScenarioController {
  private readonly queues = new Map<P12FakeEndpoint, P12FakeScenario[]>();

  enqueue(endpoint: P12FakeEndpoint, scenario: P12FakeScenario): void {
    const queue = this.queues.get(endpoint) ?? [];
    queue.push(scenario);
    this.queues.set(endpoint, queue);
  }

  take(endpoint: P12FakeEndpoint): P12FakeScenario {
    const queue = this.queues.get(endpoint);
    return queue?.shift() ?? "success";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function failScenario(
  endpoint: string,
  scenario: P12FakeScenario,
): void {
  if (scenario === "timeout") throw new Error(`${endpoint} timed out`);
  if (scenario === "partial_failure") {
    throw new Error(`${endpoint} partial failure after an earlier durable effect`);
  }
}

class P12CodexFake implements PlannerPort, GoalVerifierPort {
  private sequence = 0;
  private readonly fixture: P12RecordedContracts;
  private readonly scenarios: P12ScenarioController;

  constructor(
    fixture: P12RecordedContracts,
    scenarios: P12ScenarioController,
  ) {
    this.fixture = fixture;
    this.scenarios = scenarios;
  }

  async plan<T = unknown>(request: PlannerRequest): Promise<PlannerDraft<T>> {
    const scenario = this.scenarios.take("codex.plan");
    if (scenario === "timeout") {
      throw new PlannerExecutionError("planner_timeout");
    }
    if (scenario === "partial_failure") {
      throw new PlannerExecutionError("planner_failed");
    }
    this.sequence += 1;
    return {
      status: "draft",
      plannerRunId: `p12-planner-${this.sequence}`,
      goalId: request.goal.id,
      sourceGoalVersion: request.goal.version,
      output: clone(scenario === "invalid_output"
        ? { schemaVersion: "planner-clarification.v1", unexpected: true }
        : this.fixture.codex.plannerOutput) as T,
    };
  }

  async verify(
    request: Parameters<GoalVerifierPort["verify"]>[0],
  ): Promise<unknown> {
    void request;
    const scenario = this.scenarios.take("codex.verify");
    failScenario("codex.verify", scenario);
    return clone(scenario === "invalid_output"
      ? { schemaVersion: "goal-verifier-output.v1" }
      : this.fixture.codex.verifierOutput);
  }
}

class P12AutoDevFake implements ExecutionGatewayPort {
  private readonly statuses = new Map<string, ExternalExecutionStatus>();
  private readonly fixture: P12RecordedContracts;
  private readonly scenarios: P12ScenarioController;
  readonly effects: string[] = [];

  constructor(
    fixture: P12RecordedContracts,
    scenarios: P12ScenarioController,
  ) {
    this.fixture = fixture;
    this.scenarios = scenarios;
  }

  async start(request: ExecutionStartRequest): Promise<ExternalExecutionStatus> {
    const scenario = this.scenarios.take("autodev.start");
    failScenario("autodev.start", scenario);
    if (scenario === "invalid_output") {
      return {
        externalRunId: request.externalRunId,
        state: "unknown",
        phase: "unknown",
      };
    }
    const prior = this.statuses.get(request.externalRunId);
    if (prior) return clone(prior);
    const status = {
      ...clone(this.fixture.autodev.startStatus),
      externalRunId: request.externalRunId,
    };
    this.statuses.set(request.externalRunId, status);
    this.effects.push(`start:${request.externalRunId}`);
    return clone(status);
  }

  async inspect(externalRunId: string): Promise<ExternalExecutionStatus | null> {
    const scenario = this.scenarios.take("autodev.inspect");
    failScenario("autodev.inspect", scenario);
    return clone(this.statuses.get(externalRunId) ?? null);
  }

  async cancel(externalRunId: string): Promise<void> {
    const current = this.statuses.get(externalRunId);
    if (!current) return;
    this.statuses.set(externalRunId, {
      externalRunId,
      state: "cancelled",
      phase: "cancelled",
      message: "Cancelled by the P12 contract environment",
    });
    this.effects.push(`cancel:${externalRunId}`);
  }

  events(externalRunId: string): AutoDevRunEventV1[] {
    const scenario = this.scenarios.take("autodev.events");
    failScenario("autodev.events", scenario);
    const raw = this.fixture.autodev.events.map((event) => clone(event));
    const selected = scenario === "duplicate"
      ? [raw[0], raw[0], ...raw.slice(1)]
      : scenario === "out_of_order"
      ? [...raw].reverse()
      : scenario === "invalid_output"
      ? [{ ...raw[0], schema_version: "autodev.run-event.v0" }]
      : raw;
    return selected.map((event) => normalizeAutoDevRunEvent(
      event,
      externalRunId,
      this.fixture.fixed.issueId,
    ));
  }
}

class P12GitFake implements GitDeliveryPort {
  readonly effects: string[] = [];
  private readonly receipts = new Map<string, unknown>();
  private readonly fixture: P12RecordedContracts;
  private readonly scenarios: P12ScenarioController;

  constructor(
    fixture: P12RecordedContracts,
    scenarios: P12ScenarioController,
  ) {
    this.fixture = fixture;
    this.scenarios = scenarios;
  }

  private operation<T>(
    endpoint: P12FakeEndpoint,
    operationKey: string,
    receipt: T,
  ): T {
    const scenario = this.scenarios.take(endpoint);
    failScenario(endpoint, scenario);
    const identity = `${endpoint}:${operationKey}`;
    const prior = this.receipts.get(identity);
    if (prior) return clone(prior as T);
    const result = clone(receipt);
    this.receipts.set(identity, result);
    const effect = endpoint === "git.createCommit" ? "commit"
      : endpoint === "git.pushBranch" ? "push"
      : endpoint === "git.openPullRequest" ? "pullRequest"
      : "landing";
    this.effects.push(`${effect}:${operationKey}`);
    return clone(result);
  }

  async createCommit(
    input: Parameters<GitDeliveryPort["createCommit"]>[0],
  ) {
    return this.operation(
      "git.createCommit",
      input.operationKey,
      this.fixture.git.commit,
    );
  }

  async pushBranch(
    input: Parameters<GitDeliveryPort["pushBranch"]>[0],
  ) {
    return this.operation(
      "git.pushBranch",
      input.operationKey,
      this.fixture.git.push,
    );
  }

  async openPullRequest(
    input: Parameters<GitDeliveryPort["openPullRequest"]>[0],
  ) {
    return this.operation(
      "git.openPullRequest",
      input.operationKey,
      this.fixture.git.pullRequest,
    );
  }

  async mergePullRequest(
    input: Parameters<GitDeliveryPort["mergePullRequest"]>[0],
  ) {
    return this.operation(
      "git.mergePullRequest",
      input.operationKey,
      this.fixture.git.landing,
    );
  }
}

class P12ObjectStoreFake implements ObjectStorePort {
  private readonly delegate: MemoryObjectStore;
  private readonly fixture: P12RecordedContracts;
  private readonly scenarios: P12ScenarioController;

  constructor(
    fixture: P12RecordedContracts,
    scenarios: P12ScenarioController,
    clock: () => Date,
  ) {
    this.fixture = fixture;
    this.scenarios = scenarios;
    this.delegate = new MemoryObjectStore({ clock });
  }

  async putImmutable(
    input: ImmutableObjectUpload,
  ): Promise<ImmutableObjectDescriptor> {
    const scenario = this.scenarios.take("objectStore.put");
    failScenario("objectStore.put", scenario);
    return await this.delegate.putImmutable(input);
  }

  async read(input: Parameters<ObjectStorePort["read"]>[0]) {
    const scenario = this.scenarios.take("objectStore.read");
    failScenario("objectStore.read", scenario);
    return await this.delegate.read(input);
  }

  async createDownloadGrant(
    input: Parameters<ObjectStorePort["createDownloadGrant"]>[0],
  ): Promise<ObjectDownloadGrant> {
    return await this.delegate.createDownloadGrant(input);
  }

  upload(): ImmutableObjectUpload {
    const bytes = new TextEncoder().encode(this.fixture.objectStore.content);
    return {
      scope: {
        organizationId: this.fixture.fixed.organizationId,
        projectId: this.fixture.fixed.projectId,
      },
      body: (async function* () { yield bytes; })(),
      mediaType: this.fixture.objectStore.mediaType,
      maxBytes: 64 * 1024,
      createdAt: this.fixture.fixed.now,
      createdBy: "p12-contract-environment",
      retentionPolicy: "standard_180d",
      retentionUntil: "2027-02-01T08:00:00.000Z",
    };
  }

  async putText(): Promise<ImmutableObjectDescriptor> {
    return await this.putImmutable(this.upload());
  }

  async readText(objectKey: string): Promise<string | null> {
    const bytes = await this.read({
      scope: {
        organizationId: this.fixture.fixed.organizationId,
        projectId: this.fixture.fixed.projectId,
      },
      objectKey,
    });
    return bytes ? new TextDecoder().decode(bytes) : null;
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

class P12OidcIssuer {
  readonly config: OidcConfig;
  readonly fetch: typeof fetch;
  private nonce = "";
  private readonly fixture: P12RecordedContracts;
  private readonly scenarios: P12ScenarioController;
  private readonly privateKey: CryptoKey;
  private readonly publicJwk: JsonWebKey;
  private readonly clock: () => Date;

  private constructor(
    fixture: P12RecordedContracts,
    scenarios: P12ScenarioController,
    privateKey: CryptoKey,
    publicJwk: JsonWebKey,
    clock: () => Date,
  ) {
    this.fixture = fixture;
    this.scenarios = scenarios;
    this.privateKey = privateKey;
    this.publicJwk = publicJwk;
    this.clock = clock;
    this.config = {
      issuer: fixture.oidc.issuer,
      clientId: fixture.oidc.clientId,
      redirectUri: "https://localhost:4174/auth/callback",
      cookieSecret: Buffer.alloc(32, 12).toString("base64url"),
      allowedReturnToPaths: ["/"],
      sessionTtlSeconds: 3_600,
      transactionTtlSeconds: 600,
    };
    this.fetch = this.handleFetch.bind(this) as typeof fetch;
  }

  static async create(
    fixture: P12RecordedContracts,
    scenarios: P12ScenarioController,
    clock: () => Date,
  ): Promise<P12OidcIssuer> {
    const keys = await crypto.subtle.generateKey({
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    }, true, ["sign", "verify"]);
    const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    Object.assign(publicJwk, { kid: "p12-contract", alg: "RS256", use: "sig" });
    return new P12OidcIssuer(
      fixture,
      scenarios,
      keys.privateKey,
      publicJwk,
      clock,
    );
  }

  authorize(authorizationUrl: string): void {
    this.nonce = new URL(authorizationUrl).searchParams.get("nonce") ?? "";
  }

  private async handleFetch(input: RequestInfo | URL): Promise<Response> {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      const scenario = this.scenarios.take("oidc.discovery");
      failScenario("oidc.discovery", scenario);
      return Response.json({
        issuer: this.fixture.oidc.issuer,
        authorization_endpoint: `${this.fixture.oidc.issuer}/authorize`,
        token_endpoint: `${this.fixture.oidc.issuer}/token`,
        jwks_uri: `${this.fixture.oidc.issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.endsWith("/jwks")) {
      const scenario = this.scenarios.take("oidc.jwks");
      failScenario("oidc.jwks", scenario);
      return Response.json({ keys: [this.publicJwk] });
    }
    if (url.endsWith("/token")) {
      const scenario = this.scenarios.take("oidc.token");
      failScenario("oidc.token", scenario);
      if (scenario === "invalid_output") return Response.json({});
      const now = Math.floor(this.clock().getTime() / 1_000);
      const header = encode({ alg: "RS256", kid: "p12-contract", typ: "JWT" });
      const payload = encode({
        iss: this.fixture.oidc.issuer,
        sub: this.fixture.oidc.subject,
        aud: this.fixture.oidc.clientId,
        nonce: this.nonce,
        iat: now,
        exp: now + 3_600,
        email: this.fixture.oidc.email,
        name: this.fixture.oidc.name,
      });
      const signingInput = `${header}.${payload}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        this.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return Response.json({
        id_token: `${signingInput}.${Buffer.from(signature).toString("base64url")}`,
      });
    }
    return new Response(null, { status: 404 });
  }
}

export async function createP12ContractEnvironment(
  fixture: P12RecordedContracts,
) {
  if (fixture.schemaVersion !== "harness.p12-recorded-contracts.v1" ||
    !Number.isFinite(Date.parse(fixture.fixed.now))) {
    throw new Error("P12 recorded contract fixture is unsupported");
  }
  const scenarios = new P12ScenarioController();
  const clock = () => new Date(fixture.fixed.now);
  const objectStoreRoot = await mkdtemp(join(tmpdir(), "p12-object-store-"));
  const objectStore = new P12ObjectStoreFake(fixture, scenarios, clock);
  const productionObjectStore = new FileSystemObjectStore({
    root: objectStoreRoot,
    clock,
    downloadBaseUrl: "https://objects.example.invalid/p12",
    signingSecret: "p12-contract-signing-key",
  });
  const productionAutoDev = new AutoDevCliExecutionGateway({
    pythonExecutable: "/usr/bin/python3",
    projectConfigPath: "/srv/autodev/p12-project.yaml",
    trustedRunnerEnforcesNetwork: true,
    environment: { PATH: "/usr/bin" },
    secretResolver: async () => ({}),
    workspaceManager: {
      async create() { return "/tmp/p12-production-adapter-contract"; },
      async cleanup() {},
    },
    processRunner: async (request) => {
      const index = request.arguments.indexOf("--run-id");
      const externalRunId = index >= 0 ? request.arguments[index + 1] : "unknown";
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          run_id: externalRunId,
          status: "builder_running",
          phase: "builder",
          message: "Production adapter contract fixture",
        }),
        stderr: "",
      };
    },
  });
  const codexRunner = async (request: {
    outputPath: string;
    stdin: string;
  }) => {
    const output = request.stdin.includes("independent Goal Verifier")
      ? fixture.codex.verifierOutput
      : fixture.codex.plannerOutput;
    await writeFile(request.outputPath, JSON.stringify(output), {
      encoding: "utf8",
      mode: 0o600,
    });
    return {
      exitCode: 0,
      timedOut: false,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
  };
  const productionCodexPlanner = new CodexPlannerAdapter({
    runner: codexRunner,
    environment: { PATH: "/usr/bin" },
  });
  const productionCodexVerifier = new CodexGoalVerifierAdapter({
    runner: codexRunner,
    environment: { PATH: "/usr/bin" },
  });
  let productionGitHead = "a".repeat(40);
  const reviewedCommit = fixture.git.commit.commitSha;
  const productionGit = new GitCliGitHubDeliveryAdapter({
    gitExecutable: "/usr/bin/git",
    clock,
    processRunner: async (request) => {
      const args = request.arguments;
      if (args[0] === "symbolic-ref") {
        return { exitCode: 0, stdout: `${fixture.git.push.remoteBranch}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1]?.endsWith("^{commit}")) {
        return { exitCode: 0, stdout: `${reviewedCommit}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${productionGitHead}\n`, stderr: "" };
      }
      if (args[0] === "status") {
        return { exitCode: 0, stdout: " M README.md\n", stderr: "" };
      }
      if (args[0] === "commit") productionGitHead = reviewedCommit;
      if (args[0] === "show") {
        return { exitCode: 0, stdout: fixture.git.commit.summary, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes("state=open")) return Response.json([]);
      if (url.endsWith("/pulls") && init?.method === "POST") {
        return Response.json({
          number: Number(fixture.git.pullRequest.externalId),
          html_url: fixture.git.pullRequest.url,
          head: { sha: reviewedCommit, ref: fixture.git.push.remoteBranch },
          base: { ref: "main" },
          created_at: fixture.fixed.now,
        });
      }
      if (url.endsWith(`/pulls/${fixture.git.pullRequest.externalId}`)) {
        return Response.json({ merged: false, head: { sha: reviewedCommit } });
      }
      if (url.endsWith(`/pulls/${fixture.git.pullRequest.externalId}/merge`)) {
        return Response.json({
          merged: true,
          sha: fixture.git.landing.landingCommitSha,
        });
      }
      return new Response(null, { status: 404 });
    },
    repositoryResolver: async () => ({
      owner: "p12",
      name: "contract",
      apiBaseUrl: "https://api.github.example.invalid",
    }),
  });

  let contractSequence = 0;
  const assertGatewayContract = async (gateway: ExecutionGatewayPort) => {
    contractSequence += 1;
    const externalRunId = `p12-contract-${contractSequence}`;
    const started = await gateway.start({
      externalTaskId: fixture.fixed.issueId,
      externalRunId,
      selectedSecrets: [],
      timeoutMs: 10_000,
    });
    if (started.externalRunId !== externalRunId ||
      !["starting", "running", "succeeded"].includes(started.state) ||
      !started.phase.trim()) {
      throw new Error("Execution gateway violated the P12 shared contract");
    }
    const inspected = await gateway.inspect(externalRunId);
    if (!inspected || inspected.externalRunId !== externalRunId) {
      throw new Error("Execution gateway inspect violated the P12 shared contract");
    }
  };

  const assertObjectStoreContract = async (store: ObjectStorePort) => {
    const upload = objectStore.upload();
    const first = await store.putImmutable(upload);
    const bytes = await store.read({ scope: upload.scope, objectKey: first.objectKey });
    if (!bytes || new TextDecoder().decode(bytes) !== fixture.objectStore.content) {
      throw new Error("Object store violated the P12 shared contract");
    }
    const replay = await store.putImmutable(objectStore.upload());
    if (replay.objectKey !== first.objectKey || !replay.deduplicated) {
      throw new Error("Object store did not preserve immutable idempotency");
    }
  };

  return {
    fixture,
    clock,
    scenarios,
    codex: new P12CodexFake(fixture, scenarios),
    autodev: new P12AutoDevFake(fixture, scenarios),
    git: new P12GitFake(fixture, scenarios),
    objectStore,
    oidc: await P12OidcIssuer.create(fixture, scenarios, clock),
    productionAdapters: {
      autodev: productionAutoDev,
      objectStore: productionObjectStore,
      codex: {
        plan: productionCodexPlanner.plan.bind(productionCodexPlanner),
        verify: productionCodexVerifier.verify.bind(productionCodexVerifier),
      },
      git: productionGit,
    },
    assertGatewayContract,
    assertObjectStoreContract,
    async cleanup() {
      await rm(objectStoreRoot, { recursive: true, force: true });
    },
  };
}
