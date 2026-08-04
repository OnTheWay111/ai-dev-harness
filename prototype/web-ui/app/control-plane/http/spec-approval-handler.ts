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
  SpecApprovalValidationError,
  type SpecApprovalService,
} from "../application/spec-approval-service.ts";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import type {
  ScopeChange,
  SpecApprovalDecision,
} from "../domain/spec-approval.ts";

function failure(code: string, status: number) {
  return withSecurityHeaders(Response.json({ error: {
    code,
    message: "The specification approval was not completed",
    preservedState: "The prior SpecRevision and your browser draft remain unchanged",
  } }, { status, headers: { "cache-control": "private, no-store" } }));
}

function mapError(error: unknown): Response {
  if (error instanceof RequestSecurityError) return failure(error.code, error.status);
  if (error instanceof AuthorizationDeniedError) return failure("forbidden", 403);
  if (error instanceof VersionConflictError) return failure("version_conflict", 409);
  if (error instanceof IdempotencyConflictError) return failure("idempotency_conflict", 409);
  if (error instanceof IdempotencyInProgressError) return failure("idempotency_in_progress", 409);
  if (error instanceof SpecApprovalValidationError) return failure("validation_failed", 400);
  return failure("internal_error", 500);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new SpecApprovalValidationError(`${name} is required`);
  return value;
}

export function createSpecApprovalHandler(input: {
  service: Pick<SpecApprovalService, "decide" | "timeline">;
  actorResolver(request: Request): Promise<{ actorId: string } | null>;
  rateLimiter?: RateLimiter;
  allowedOrigins?: readonly string[];
}) {
  return async (
    request: Request,
    goalId: string,
    specRevisionId: string,
  ): Promise<Response> => {
    try {
      if (request.method === "GET") {
        const actor = await input.actorResolver(request);
        if (!actor) return failure("authentication_required", 401);
        const url = new URL(request.url);
        if ([...url.searchParams.keys()].some((key) =>
          !["organizationId", "projectId"].includes(key)
        )) throw new SpecApprovalValidationError("unknown query field");
        const organizationId = url.searchParams.get("organizationId");
        const projectId = url.searchParams.get("projectId");
        if (!validId(organizationId) || !validId(projectId) ||
          !validId(goalId) || !validId(specRevisionId)) {
          throw new SpecApprovalValidationError("valid scope is required");
        }
        return withSecurityHeaders(Response.json({
          data: await input.service.timeline({
            organizationId,
            projectId,
            goalId,
            actorId: actor.actorId,
          }),
        }, { headers: { "cache-control": "private, no-store" } }));
      }
      if (request.method !== "POST") return failure("not_found", 404);
      assertSameOrigin(request, input.allowedOrigins);
      const actor = await input.actorResolver(request);
      if (!actor) return failure("authentication_required", 401);
      const requestId = requiredHeader(request, "x-request-id");
      const idempotencyKey = requiredHeader(request, "idempotency-key");
      const value = await readJsonBody(request, 32 * 1024);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SpecApprovalValidationError("object body required");
      }
      const body = value as Record<string, unknown>;
      const allowed = [
        "organizationId",
        "projectId",
        "expectedVersion",
        "reason",
        "policyRevision",
        "decision",
        "affectedElementIds",
        "helpfulExceptionElementIds",
        "scopeChanges",
      ];
      if (Object.keys(body).some((key) => !allowed.includes(key))) {
        throw new SpecApprovalValidationError("unknown body field");
      }
      if (!validId(body.organizationId) || !validId(body.projectId) ||
        !validId(goalId) || !validId(specRevisionId)) {
        throw new SpecApprovalValidationError("valid scope is required");
      }
      (input.rateLimiter ?? defaultWriteRateLimiter).consume({
        actorId: actor.actorId,
        organizationId: body.organizationId,
        endpoint: "spec.approval",
      });
      const receipt = await input.service.decide({
        organizationId: body.organizationId,
        projectId: body.projectId,
        goalId,
        specRevisionId,
        expectedVersion: Number(body.expectedVersion),
        actorId: actor.actorId,
        reason: String(body.reason ?? ""),
        requestId,
        idempotencyKey,
        policyRevision: String(body.policyRevision ?? ""),
        decision: body.decision as SpecApprovalDecision,
        affectedElementIds: body.affectedElementIds as readonly string[],
        helpfulExceptionElementIds: body.helpfulExceptionElementIds as readonly string[],
        scopeChanges: body.scopeChanges as readonly ScopeChange[],
      });
      return withSecurityHeaders(Response.json({ data: receipt }));
    } catch (error) {
      return mapError(error);
    }
  };
}
