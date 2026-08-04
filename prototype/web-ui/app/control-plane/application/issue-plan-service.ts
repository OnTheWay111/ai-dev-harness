import { canonicalJson, sha256Hex } from "../domain/spec-artifact.ts";
import { VersionConflictError } from "../domain/errors.ts";
import {
  compileIssuePlan,
  issueCompilerPolicyRevision,
} from "../domain/issue-compiler.ts";
import {
  conflictPolicyRevision,
  scheduleExecutionWaves,
} from "../domain/execution-waves.ts";
import {
  issuePlanSchemaVersion,
  validateIssuePlanDraft,
  type IssueDraft,
  type IssuePlan,
  type IssuePlannerConfiguration,
  type IssuePlanSource,
} from "../domain/issue-plan.ts";
import {
  issuePlanApprovalPolicyRevision,
  type IssuePlanApprovalCommand,
  type IssuePlanApprovalDecisionRecord,
  type IssuePlanApprovalReceipt,
} from "../domain/issue-plan-approval.ts";
import {
  modelRouterPolicyRevision,
  recommendModelRoute,
  withModelRouteOverride,
  type ModelRouteOverride,
} from "../domain/model-router.ts";
import type {
  IssuePlanIdempotencyLookup,
  IssuePlanRepository,
  IssuePlanScope,
} from "../ports/issue-plan-repository.ts";

export class IssuePlanApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuePlanApprovalError";
  }
}

export interface IssuePlanAuthorizer {
  authorize(input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    permission: "issue.generate" | "issue.read" | "issue.edit" | "issue.approve" | "issue.project";
  }): Promise<void>;
}

interface CreateDraftCommand {
  scope: IssuePlanScope;
  source: IssuePlanSource;
  draft: unknown;
  plannerRunId: string;
  plannerConfiguration: IssuePlannerConfiguration;
  actorId: string;
}

interface ReviseCommand {
  scope: IssuePlanScope;
  planId: string;
  expectedVersion: number;
  actorId: string;
  reason: string;
  requestId: string;
  issues: readonly IssueDraft[];
  modelOverrides: readonly (Pick<ModelRouteOverride,
    "capabilityTier" | "reasoningEffort" | "reason"> & { issueKey: string })[];
}

function nonBlank(value: string, name: string, maximum = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new IssuePlanApprovalError(`${name} must be non-blank and bounded`);
  }
  return value.trim();
}

function exactIssueKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

async function planDigest(input: {
  source: IssuePlanSource;
  issues: readonly IssueDraft[];
  compilation: IssuePlan["compilation"];
  conflicts: IssuePlan["conflicts"];
  waves: IssuePlan["waves"];
  modelRecommendations: IssuePlan["modelRecommendations"];
}): Promise<string> {
  return await sha256Hex(canonicalJson({
    schemaVersion: issuePlanSchemaVersion,
    ...input,
    compilerPolicyRevision: issueCompilerPolicyRevision,
    conflictPolicyRevision,
    modelRouterPolicyRevision,
  }));
}

export class IssuePlanService {
  private readonly repository: IssuePlanRepository;
  private readonly authorizer: IssuePlanAuthorizer;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(input: {
    repository: IssuePlanRepository;
    authorizer: IssuePlanAuthorizer;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.repository = input.repository;
    this.authorizer = input.authorizer;
    this.clock = input.clock ?? (() => new Date());
    this.idGenerator = input.idGenerator ?? (() => crypto.randomUUID());
  }

  private async build(input: {
    scope: IssuePlanScope;
    source: IssuePlanSource;
    issues: readonly IssueDraft[];
    previous: IssuePlan | null;
    plannerRunId: string;
    plannerConfiguration: IssuePlannerConfiguration;
    modelOverrides?: readonly (ModelRouteOverride & { issueKey: string })[];
  }): Promise<IssuePlan> {
    const compilation = compileIssuePlan({
      requirements: input.source.requirements,
      acceptanceCriterionIds: input.source.acceptanceCriterionIds,
      issues: input.issues,
    });
    const execution = scheduleExecutionWaves(input.issues);
    const modelRecommendations = input.issues
      .map((issue) => {
        const recommended = recommendModelRoute(issue);
        const override = input.modelOverrides?.find(({ issueKey }) => issueKey === issue.key);
        return override ? withModelRouteOverride(recommended, override) : recommended;
      })
      .sort((left, right) => left.issueKey.localeCompare(right.issueKey));
    const digest = await planDigest({
      source: input.source,
      issues: input.issues,
      compilation,
      conflicts: execution.conflicts,
      waves: execution.waves,
      modelRecommendations,
    });
    const now = this.clock().toISOString();
    return {
      schemaVersion: issuePlanSchemaVersion,
      id: this.idGenerator(),
      ...input.scope,
      revision: (input.previous?.revision ?? 0) + 1,
      previousPlanId: input.previous?.id ?? null,
      status: "draft",
      source: structuredClone(input.source),
      issues: structuredClone(input.issues),
      compilation,
      conflicts: execution.conflicts,
      waves: execution.waves,
      modelRecommendations,
      plannerRunId: input.plannerRunId,
      plannerConfiguration: input.plannerConfiguration,
      compilerPolicyRevision: issueCompilerPolicyRevision,
      conflictPolicyRevision,
      modelRouterPolicyRevision,
      digest,
      generatedAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  async createDraft(command: CreateDraftCommand): Promise<{ plan: IssuePlan }> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.scope.organizationId,
      projectId: command.scope.projectId,
      permission: "issue.generate",
    });
    const draft = validateIssuePlanDraft(command.draft);
    const previous = await this.repository.getLatest(command.scope);
    const plan = await this.build({
      scope: command.scope,
      source: command.source,
      issues: draft.issues,
      previous,
      plannerRunId: nonBlank(command.plannerRunId, "plannerRunId", 200),
      plannerConfiguration: command.plannerConfiguration,
    });
    return {
      plan: await this.repository.append({
        plan,
        expectedPreviousPlanId: previous?.id ?? null,
      }),
    };
  }

  async revise(command: ReviseCommand): Promise<{ plan: IssuePlan }> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.scope.organizationId,
      projectId: command.scope.projectId,
      permission: "issue.edit",
    });
    nonBlank(command.reason, "reason");
    nonBlank(command.requestId, "requestId", 200);
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) {
      throw new IssuePlanApprovalError("expectedVersion must be positive");
    }
    const current = await this.repository.get({ ...command.scope, planId: command.planId });
    const latest = await this.repository.getLatest(command.scope);
    if (!current || current.id !== latest?.id || current.version !== command.expectedVersion ||
      current.status !== "draft") throw new VersionConflictError();
    const draft = validateIssuePlanDraft({
      schemaVersion: "issue-plan-draft.v1",
      issues: command.issues,
    });
    const issueKeys = new Set(draft.issues.map(({ key }) => key));
    const submittedKeys = command.modelOverrides.map(({ issueKey }) => issueKey);
    if (new Set(submittedKeys).size !== submittedKeys.length ||
      submittedKeys.some((issueKey) => !issueKeys.has(issueKey))) {
      throw new IssuePlanApprovalError(
        "modelOverrides must identify unique Issues in the revised plan",
      );
    }
    const submitted = new Map(command.modelOverrides.map(({ issueKey, ...override }) => {
      const reason = nonBlank(override.reason, `modelOverrides.${issueKey}.reason`);
      return [issueKey, {
        ...override,
        reason,
        actorId: command.actorId,
        overriddenAt: this.clock().toISOString(),
      }];
    }));
    const currentRoutes = new Map(current.modelRecommendations.map((route) => [
      route.issueKey,
      route,
    ]));
    const modelOverrides = draft.issues.flatMap(({ key }) => {
      const replacement = submitted.get(key);
      if (replacement) return [{ issueKey: key, ...replacement }];
      const prior = currentRoutes.get(key)?.override;
      return prior ? [{ issueKey: key, ...prior }] : [];
    });
    const plan = await this.build({
      scope: command.scope,
      source: current.source,
      issues: draft.issues,
      previous: current,
      plannerRunId: current.plannerRunId,
      plannerConfiguration: current.plannerConfiguration,
      modelOverrides,
    });
    return {
      plan: await this.repository.append({
        plan,
        expectedPreviousPlanId: current.id,
      }),
    };
  }

  async timeline(command: IssuePlanScope & { actorId: string }) {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "issue.read",
    });
    return await this.repository.list(command);
  }

  async get(command: IssuePlanScope & { planId: string; actorId: string }) {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "issue.read",
    });
    return await this.repository.get(command);
  }

  async approve(command: IssuePlanApprovalCommand): Promise<IssuePlanApprovalReceipt> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.scope.organizationId,
      projectId: command.scope.projectId,
      permission: "issue.approve",
    });
    if (command.target?.type !== "issue_plan" || !command.target.id ||
      !Number.isInteger(command.expectedVersion) || command.expectedVersion < 1 ||
      command.policyRevision !== issuePlanApprovalPolicyRevision) {
      throw new IssuePlanApprovalError("approval target, version, or policy is invalid");
    }
    const actorId = nonBlank(command.actorId, "actorId", 200);
    const reason = nonBlank(command.reason, "reason");
    const requestId = nonBlank(command.requestId, "requestId", 200);
    nonBlank(command.idempotencyKey, "idempotencyKey", 200);
    if (!(["approve", "reject", "request_changes"] as const).includes(command.decision) ||
      !command.payload || Object.keys(command.payload).length > 0 ||
      command.affectedItemIds.length === 0) {
      throw new IssuePlanApprovalError("approval command is incomplete");
    }
    const requestHash = await sha256Hex(canonicalJson(command));
    const lookup: IssuePlanIdempotencyLookup = {
      organizationId: command.scope.organizationId,
      actorId,
      endpoint: "issue_plan.approval",
      key: command.idempotencyKey,
      requestHash,
    };
    const replay = await this.repository.findApprovalReceipt(lookup);
    if (replay) return replay;
    const current = await this.repository.get({ ...command.scope, planId: command.target.id });
    const latest = await this.repository.getLatest(command.scope);
    if (!current || current.id !== latest?.id || current.version !== command.expectedVersion ||
      current.status !== "draft") throw new VersionConflictError();
    if (!exactIssueKeys(command.affectedItemIds, current.issues.map(({ key }) => key))) {
      throw new IssuePlanApprovalError("affectedItemIds must bind every Issue in this plan revision");
    }
    if (command.decision === "approve" && (!current.compilation.valid ||
      current.waves.flatMap(({ issueKeys }) => issueKeys).length !== current.issues.length ||
      current.modelRecommendations.length !== current.issues.length)) {
      throw new IssuePlanApprovalError("invalid or incomplete plans cannot be approved");
    }
    const occurredAt = this.clock();
    const occurredAtIso = occurredAt.toISOString();
    const next: IssuePlan = {
      ...current,
      status: command.decision === "approve"
        ? "approved"
        : command.decision === "request_changes"
        ? "draft"
        : "rejected",
      version: current.version + 1,
      updatedAt: occurredAtIso,
    };
    const decision: IssuePlanApprovalDecisionRecord = {
      id: this.idGenerator(),
      ...command.scope,
      issuePlanId: current.id,
      subjectVersion: current.version,
      planDigest: current.digest,
      decision: command.decision,
      actorId,
      reason,
      requestId,
      policyRevision: command.policyRevision,
      affectedIssueKeys: [...command.affectedItemIds].sort(),
      createdAt: occurredAtIso,
    };
    const receipt: IssuePlanApprovalReceipt = {
      receiptId: this.idGenerator(),
      target: command.target,
      previousVersion: current.version,
      currentVersion: next.version,
      decision: command.decision,
      actorId,
      reason,
      requestId,
      policyRevision: command.policyRevision,
      recordedAt: occurredAtIso,
      result: { plan: next, planDigest: current.digest, decisionRecord: decision },
    };
    const action = command.decision === "approve"
      ? "issue_plan.approved" as const
      : command.decision === "reject"
      ? "issue_plan.rejected" as const
      : "issue_plan.changes_requested" as const;
    const eventId = this.idGenerator();
    return await this.repository.commitApproval({
      current,
      next,
      expectedVersion: command.expectedVersion,
      decision,
      audit: {
        id: this.idGenerator(),
        ...command.scope,
        actorId,
        action,
        entityId: current.id,
        entityVersion: next.version,
        reason,
        requestId,
        policyRevision: command.policyRevision,
        createdAt: occurredAtIso,
      },
      event: {
        id: eventId,
        organizationId: command.scope.organizationId,
        aggregateId: current.id,
        aggregateVersion: next.version,
        type: "issue_plan.approval.recorded",
        occurredAt: occurredAtIso,
        payload: {
          decision: command.decision,
          planDigest: current.digest,
          requestId,
          receipt,
        },
      },
      idempotency: {
        ...lookup,
        responseDigest: await sha256Hex(canonicalJson(receipt)),
        expiresAt: new Date(occurredAt.getTime() + 24 * 60 * 60 * 1_000),
      },
      receipt,
    });
  }
}
