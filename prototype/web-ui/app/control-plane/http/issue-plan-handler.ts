import { AuthorizationDeniedError } from "../../auth/rbac-policy.ts";
import {
  assertSameOrigin,
  defaultWriteRateLimiter,
  readJsonBody,
  RequestSecurityError,
  withSecurityHeaders,
  type RateLimiter,
} from "../../security/request-security.ts";
import {
  AutoDevQueueImportContractError,
  AutoDevQueueImportUnavailableError,
} from "../adapters/autodev-queue-import-adapter.ts";
import {
  IssuePlanApprovalError,
  type IssuePlanService,
} from "../application/issue-plan-service.ts";
import type { IssuePlanGenerationService } from
  "../application/issue-plan-generation-service.ts";
import type { QueueProjectionService } from
  "../application/queue-projection-service.ts";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import {
  IssuePlanValidationError,
  type IssueDraft,
} from "../domain/issue-plan.ts";
import {
  capabilityTiers,
  ModelRouteUnavailableError,
  reasoningEfforts,
  type CapabilityTier,
  type ReasoningEffort,
} from "../domain/model-router.ts";

class AuthenticationRequiredError extends Error {}

function failure(code: string, status: number) {
  return withSecurityHeaders(Response.json({ error: {
    code,
    message: "The Issue plan operation was not completed",
    preservedState: "The approved revision and browser-owned draft remain unchanged",
  } }, { status, headers: { "cache-control": "private, no-store" } }));
}

function mapError(error: unknown): Response {
  if (error instanceof RequestSecurityError) return failure(error.code, error.status);
  if (error instanceof AuthenticationRequiredError) return failure("authentication_required", 401);
  if (error instanceof AuthorizationDeniedError) return failure("forbidden", 403);
  if (error instanceof VersionConflictError) return failure("version_conflict", 409);
  if (error instanceof IdempotencyConflictError) return failure("idempotency_conflict", 409);
  if (error instanceof IdempotencyInProgressError) return failure("idempotency_in_progress", 409);
  if (error instanceof AutoDevQueueImportUnavailableError) {
    return failure("queue_import_unavailable", 503);
  }
  if (error instanceof AutoDevQueueImportContractError) {
    return failure("queue_import_failed", 502);
  }
  if (error instanceof IssuePlanApprovalError ||
    error instanceof IssuePlanValidationError ||
    error instanceof ModelRouteUnavailableError ||
    error instanceof TypeError) {
    return failure("validation_failed", 400);
  }
  return failure("internal_error", 500);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new IssuePlanApprovalError(`${name} is required`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IssuePlanApprovalError("object body required");
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new IssuePlanApprovalError("unknown body field");
  }
}

function scopeFrom(value: Record<string, unknown>, goalId: string) {
  if (!validId(value.organizationId) || !validId(value.projectId) || !validId(goalId)) {
    throw new IssuePlanApprovalError("valid scope is required");
  }
  return {
    organizationId: value.organizationId,
    projectId: value.projectId,
    goalId,
  };
}

function queryScope(request: Request, goalId: string) {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) =>
    !["organizationId", "projectId"].includes(key)
  )) throw new IssuePlanApprovalError("unknown query field");
  return scopeFrom({
    organizationId: url.searchParams.get("organizationId"),
    projectId: url.searchParams.get("projectId"),
  }, goalId);
}

export function createIssuePlanHandlers(input: {
  plans: Pick<IssuePlanService, "timeline" | "revise" | "approve">;
  generation: Pick<IssuePlanGenerationService, "generate">;
  projection: Pick<QueueProjectionService, "project">;
  actorResolver(request: Request): Promise<{ actorId: string } | null>;
  rateLimiter?: RateLimiter;
  allowedOrigins?: readonly string[];
}) {
  const actor = async (request: Request) => {
    const resolved = await input.actorResolver(request);
    if (!resolved) throw new AuthenticationRequiredError();
    return resolved;
  };
  const write = async (request: Request) => {
    assertSameOrigin(request, input.allowedOrigins);
    const resolved = await actor(request);
    return {
      actorId: resolved.actorId,
      requestId: requiredHeader(request, "x-request-id"),
      idempotencyKey: requiredHeader(request, "idempotency-key"),
      body: record(await readJsonBody(request, 256 * 1024)),
    };
  };
  return {
    collection: async (request: Request, goalId: string): Promise<Response> => {
      try {
        if (request.method === "GET") {
          const resolved = await actor(request);
          return withSecurityHeaders(Response.json({ data: await input.plans.timeline({
            ...queryScope(request, goalId),
            actorId: resolved.actorId,
          }) }, { headers: { "cache-control": "private, no-store" } }));
        }
        if (request.method !== "POST") return failure("not_found", 404);
        const command = await write(request);
        exactFields(command.body, [
          "organizationId", "projectId", "specRevisionId", "expectedSpecVersion",
        ]);
        const scope = scopeFrom(command.body, goalId);
        if (!validId(command.body.specRevisionId) ||
          !Number.isInteger(command.body.expectedSpecVersion)) {
          throw new IssuePlanApprovalError("valid specification source is required");
        }
        (input.rateLimiter ?? defaultWriteRateLimiter).consume({
          actorId: command.actorId,
          organizationId: scope.organizationId,
          endpoint: "issue.generate",
        });
        return withSecurityHeaders(Response.json({ data: await input.generation.generate({
          ...scope,
          specRevisionId: command.body.specRevisionId,
          expectedSpecVersion: command.body.expectedSpecVersion as number,
          actorId: command.actorId,
        }) }));
      } catch (error) {
        return mapError(error);
      }
    },

    item: async (
      request: Request,
      goalId: string,
      planId: string,
    ): Promise<Response> => {
      try {
        if (request.method !== "PATCH") return failure("not_found", 404);
        const command = await write(request);
        exactFields(command.body, [
          "organizationId", "projectId", "expectedVersion", "reason",
          "issues", "modelOverrides",
        ]);
        const scope = scopeFrom(command.body, goalId);
        if (!validId(planId) || !Number.isInteger(command.body.expectedVersion) ||
          typeof command.body.reason !== "string" || !Array.isArray(command.body.issues) ||
          !Array.isArray(command.body.modelOverrides)) {
          throw new IssuePlanApprovalError("complete revision command is required");
        }
        const modelOverrides = command.body.modelOverrides.map((value) => {
          const override = record(value);
          exactFields(override, ["issueKey", "capabilityTier", "reasoningEffort", "reason"]);
          if (typeof override.issueKey !== "string" ||
            !capabilityTiers.includes(override.capabilityTier as CapabilityTier) ||
            !reasoningEfforts.includes(override.reasoningEffort as ReasoningEffort) ||
            typeof override.reason !== "string" || !override.reason.trim()) {
            throw new IssuePlanApprovalError("model override is invalid");
          }
          return {
            issueKey: override.issueKey,
            capabilityTier: override.capabilityTier as CapabilityTier,
            reasoningEffort: override.reasoningEffort as ReasoningEffort,
            actorId: command.actorId,
            reason: override.reason,
            overriddenAt: new Date().toISOString(),
          };
        });
        (input.rateLimiter ?? defaultWriteRateLimiter).consume({
          actorId: command.actorId,
          organizationId: scope.organizationId,
          endpoint: "issue.edit",
        });
        return withSecurityHeaders(Response.json({ data: await input.plans.revise({
          scope,
          planId,
          expectedVersion: command.body.expectedVersion as number,
          actorId: command.actorId,
          reason: command.body.reason,
          requestId: command.requestId,
          issues: command.body.issues as readonly IssueDraft[],
          modelOverrides,
        }) }));
      } catch (error) {
        return mapError(error);
      }
    },

    approval: async (
      request: Request,
      goalId: string,
      planId: string,
    ): Promise<Response> => {
      try {
        if (request.method !== "POST") return failure("not_found", 404);
        const command = await write(request);
        exactFields(command.body, [
          "organizationId", "projectId", "expectedVersion", "reason",
          "policyRevision", "decision", "affectedItemIds",
        ]);
        const scope = scopeFrom(command.body, goalId);
        if (!validId(planId) || !Number.isInteger(command.body.expectedVersion) ||
          typeof command.body.reason !== "string" ||
          typeof command.body.policyRevision !== "string" ||
          !["approve", "reject", "request_changes"].includes(String(command.body.decision)) ||
          !Array.isArray(command.body.affectedItemIds)) {
          throw new IssuePlanApprovalError("complete approval command is required");
        }
        (input.rateLimiter ?? defaultWriteRateLimiter).consume({
          actorId: command.actorId,
          organizationId: scope.organizationId,
          endpoint: "issue.approve",
        });
        return withSecurityHeaders(Response.json({ data: await input.plans.approve({
          scope,
          target: { type: "issue_plan", id: planId },
          expectedVersion: command.body.expectedVersion as number,
          actorId: command.actorId,
          reason: command.body.reason,
          requestId: command.requestId,
          idempotencyKey: command.idempotencyKey,
          policyRevision: command.body.policyRevision,
          decision: command.body.decision as "approve" | "reject" | "request_changes",
          affectedItemIds: command.body.affectedItemIds as readonly string[],
          payload: {},
        }) }));
      } catch (error) {
        return mapError(error);
      }
    },

    projection: async (
      request: Request,
      goalId: string,
      planId: string,
    ): Promise<Response> => {
      try {
        if (request.method !== "POST") return failure("not_found", 404);
        const command = await write(request);
        exactFields(command.body, ["organizationId", "projectId", "expectedVersion"]);
        const scope = scopeFrom(command.body, goalId);
        if (!validId(planId) || !Number.isInteger(command.body.expectedVersion)) {
          throw new IssuePlanApprovalError("complete projection command is required");
        }
        const timeline = await input.plans.timeline({
          ...scope,
          actorId: command.actorId,
        });
        const plan = timeline.plans.at(-1);
        if (!plan || plan.id !== planId || plan.status !== "approved" ||
          plan.version !== command.body.expectedVersion) {
          throw new VersionConflictError();
        }
        (input.rateLimiter ?? defaultWriteRateLimiter).consume({
          actorId: command.actorId,
          organizationId: scope.organizationId,
          endpoint: "issue.project",
        });
        return withSecurityHeaders(Response.json({ data: await input.projection.project({
          plan,
          actorId: command.actorId,
          requestId: command.requestId,
          idempotencyKey: command.idempotencyKey,
        }) }));
      } catch (error) {
        return mapError(error);
      }
    },
  };
}
