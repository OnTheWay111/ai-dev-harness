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
import {
  specApprovalDecisions,
  type ScopeChange,
  type SpecApprovalDecision,
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
            specRevisionId,
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
        "affectedItemIds",
        "payload",
      ];
      if (Object.keys(body).some((key) => !allowed.includes(key))) {
        throw new SpecApprovalValidationError("unknown body field");
      }
      if (!validId(body.organizationId) || !validId(body.projectId) ||
        !validId(goalId) || !validId(specRevisionId)) {
        throw new SpecApprovalValidationError("valid scope is required");
      }
      if (!body.payload || typeof body.payload !== "object" ||
        Array.isArray(body.payload) ||
        Object.keys(body.payload).some((key) =>
          !["helpfulExceptionElementIds", "scopeChanges"].includes(key)
        )) {
        throw new SpecApprovalValidationError("valid approval payload is required");
      }
      const payload = body.payload as Record<string, unknown>;
      if (!Number.isInteger(body.expectedVersion) ||
        typeof body.reason !== "string" ||
        typeof body.policyRevision !== "string" ||
        !specApprovalDecisions.includes(body.decision as SpecApprovalDecision) ||
        !Array.isArray(body.affectedItemIds) ||
        !Array.isArray(payload.helpfulExceptionElementIds) ||
        !Array.isArray(payload.scopeChanges)) {
        throw new SpecApprovalValidationError("complete approval command is required");
      }
      (input.rateLimiter ?? defaultWriteRateLimiter).consume({
        actorId: actor.actorId,
        organizationId: body.organizationId,
        endpoint: "spec.approval",
      });
      const receipt = await input.service.decide({
        scope: {
          organizationId: body.organizationId,
          projectId: body.projectId,
          goalId,
        },
        target: { type: "spec_revision", id: specRevisionId },
        expectedVersion: body.expectedVersion as number,
        actorId: actor.actorId,
        reason: body.reason,
        requestId,
        idempotencyKey,
        policyRevision: body.policyRevision,
        decision: body.decision as SpecApprovalDecision,
        affectedItemIds: body.affectedItemIds as readonly string[],
        payload: {
          helpfulExceptionElementIds:
            payload.helpfulExceptionElementIds as readonly string[],
          scopeChanges: payload.scopeChanges as readonly ScopeChange[],
        },
      });
      return withSecurityHeaders(Response.json({ data: receipt }));
    } catch (error) {
      return mapError(error);
    }
  };
}
