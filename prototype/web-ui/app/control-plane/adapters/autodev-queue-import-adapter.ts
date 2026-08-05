import type { IssuePlan } from "../domain/issue-plan.ts";
import type {
  QueueProjectionPort,
  QueueProjectionReceipt,
} from "../ports/queue-projection-port.ts";

export class AutoDevQueueImportUnavailableError extends Error {
  constructor() {
    super("A supported AutoDev atomic import endpoint is not configured");
    this.name = "AutoDevQueueImportUnavailableError";
  }
}

export class AutoDevQueueImportContractError extends Error {
  constructor(message = "AutoDev returned an invalid atomic import receipt") {
    super(message);
    this.name = "AutoDevQueueImportContractError";
  }
}

interface ImportResponse {
  importId?: unknown;
  atomic?: unknown;
  planDigest?: unknown;
  tasks?: unknown;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function waveFor(plan: IssuePlan, issueKey: string): number {
  return plan.waves.find(({ issueKeys }) => issueKeys.includes(issueKey))?.number ?? 0;
}

export class AutoDevQueueImportAdapter implements QueueProjectionPort {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetcher?: typeof fetch;
  private readonly clock: () => Date;

  constructor(input: {
    endpoint: string;
    token: string;
    fetch?: typeof fetch;
    clock?: () => Date;
  }) {
    this.endpoint = input.endpoint.trim();
    this.token = input.token.trim();
    this.fetcher = input.fetch;
    this.clock = input.clock ?? (() => new Date());
  }

  async importApprovedPlan(input: {
    plan: IssuePlan;
    requestId: string;
    idempotencyKey: string;
  }): Promise<QueueProjectionReceipt> {
    if (!this.endpoint || !this.token) throw new AutoDevQueueImportUnavailableError();
    if (input.plan.status !== "approved" || !nonBlank(input.requestId) ||
      !nonBlank(input.idempotencyKey)) {
      throw new AutoDevQueueImportContractError("Only an approved plan can be imported");
    }
    const recommendations = new Map(input.plan.modelRecommendations.map((item) => [
      item.issueKey,
      item,
    ]));
    let response: Response;
    try {
      response = await (this.fetcher ?? globalThis.fetch)(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
          "x-request-id": input.requestId,
        },
        body: JSON.stringify({
          schemaVersion: "autodev-queue-import.v1",
          atomic: true,
          issuePlanId: input.plan.id,
          planDigest: input.plan.digest,
          tasks: input.plan.issues.map((issue) => {
            const route = recommendations.get(issue.key);
            if (!route) {
              throw new AutoDevQueueImportContractError(`Missing model route for ${issue.key}`);
            }
            return {
              issueKey: issue.key,
              title: issue.title,
              goal: issue.goal,
              developmentPrompt: issue.developmentPrompt,
              acceptance: issue.acceptance,
              verify: issue.verify,
              completionEvidence: issue.completionEvidence,
              dependencies: issue.dependencyCandidates,
              expectedFiles: issue.expectedFiles,
              wave: waveFor(input.plan, issue.key),
              capabilityTier: route.capabilityTier,
              reasoningEffort: route.reasoningEffort,
              routingPolicyRevision: route.policyRevision,
            };
          }),
        }),
      });
    } catch (error) {
      if (error instanceof AutoDevQueueImportContractError) throw error;
      throw new AutoDevQueueImportContractError("AutoDev import request failed");
    }
    if (!response.ok) {
      throw new AutoDevQueueImportContractError(`AutoDev import failed with HTTP ${response.status}`);
    }
    let payload: ImportResponse;
    try {
      payload = await response.json() as ImportResponse;
    } catch {
      throw new AutoDevQueueImportContractError();
    }
    if (payload.atomic !== true || !nonBlank(payload.importId) ||
      payload.planDigest !== input.plan.digest || !Array.isArray(payload.tasks)) {
      throw new AutoDevQueueImportContractError();
    }
    const tasks = payload.tasks.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AutoDevQueueImportContractError();
      }
      const item = value as Record<string, unknown>;
      if (!nonBlank(item.issueKey) || !nonBlank(item.externalTaskId)) {
        throw new AutoDevQueueImportContractError();
      }
      return {
        issueKey: item.issueKey.trim(),
        externalTaskId: item.externalTaskId.trim(),
      };
    });
    const expected = [...input.plan.issues.map(({ key }) => key)].sort();
    const actual = [...tasks.map(({ issueKey }) => issueKey)].sort();
    if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index]) ||
      new Set(tasks.map(({ externalTaskId }) => externalTaskId)).size !== tasks.length) {
      throw new AutoDevQueueImportContractError();
    }
    return {
      importId: payload.importId.trim(),
      atomic: true,
      organizationId: input.plan.organizationId,
      projectId: input.plan.projectId,
      goalId: input.plan.goalId,
      issuePlanId: input.plan.id,
      planDigest: input.plan.digest,
      requestId: input.requestId.trim(),
      idempotencyKey: input.idempotencyKey.trim(),
      projectedAt: this.clock().toISOString(),
      tasks,
    };
  }
}
