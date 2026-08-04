import { AuthorizationDeniedError } from "../../auth/rbac-policy.ts";
import {
  assertSameOrigin, defaultWriteRateLimiter, readJsonBody, RequestSecurityError,
  withSecurityHeaders, type RateLimiter,
} from "../../security/request-security.ts";
import type { ClassificationService } from "../application/classification-service.ts";
import { ClassificationValidationError } from "../domain/classification.ts";
import { ClarificationExpiredError, ClarificationNotFoundError } from "../domain/clarification-history.ts";
import { VersionConflictError } from "../domain/errors.ts";

function failure(code: string, status: number) {
  return withSecurityHeaders(Response.json({ error: {
    code,
    message: "The deterministic classification request was not completed",
    preservedState: "The last committed classification and policy revision remain authoritative",
  } }, { status, headers: { "cache-control": "private, no-store" } }));
}

function mapError(error: unknown) {
  if (error instanceof RequestSecurityError) return failure(error.code, error.status);
  if (error instanceof AuthorizationDeniedError) return failure("forbidden", 403);
  if (error instanceof ClarificationNotFoundError) return failure("not_found", 404);
  if (error instanceof ClarificationExpiredError || error instanceof VersionConflictError) return failure("version_conflict", 409);
  if (error instanceof ClassificationValidationError) return failure("validation_failed", 400);
  return failure("internal_error", 500);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

export function createClassificationHandler(input: {
  service: Pick<ClassificationService, "timeline" | "classify">;
  actorResolver(request: Request): Promise<{ actorId: string } | null>;
  rateLimiter?: RateLimiter;
  allowedOrigins?: readonly string[];
}) {
  return async (request: Request, goalId: string) => {
    try {
      if (request.method === "GET") {
        const actor = await input.actorResolver(request);
        if (!actor) return failure("authentication_required", 401);
        const url = new URL(request.url);
        if ([...url.searchParams.keys()].some((key) => !["organizationId", "projectId"].includes(key))) throw new ClassificationValidationError("unknown query field");
        const organizationId = url.searchParams.get("organizationId");
        const projectId = url.searchParams.get("projectId");
        if (!validId(organizationId) || !validId(projectId) || !validId(goalId)) throw new ClassificationValidationError("valid scope is required");
        return withSecurityHeaders(Response.json({ data: await input.service.timeline({ organizationId, projectId, goalId, actorId: actor.actorId }) }, { headers: { "cache-control": "private, no-store" } }));
      }
      if (request.method !== "POST") return failure("not_found", 404);
      assertSameOrigin(request, input.allowedOrigins);
      const actor = await input.actorResolver(request);
      if (!actor) return failure("authentication_required", 401);
      const value = await readJsonBody(request, 16 * 1024);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClassificationValidationError("object body required");
      const body = value as Record<string, unknown>;
      if (Object.keys(body).some((key) => !["organizationId", "projectId", "expectedGoalVersion", "reason"].includes(key))) throw new ClassificationValidationError("unknown body field");
      if (!validId(body.organizationId) || !validId(body.projectId) || !validId(goalId)) throw new ClassificationValidationError("valid scope is required");
      (input.rateLimiter ?? defaultWriteRateLimiter).consume({ actorId: actor.actorId, organizationId: body.organizationId, endpoint: "goal.classify" });
      const receipt = await input.service.classify({ organizationId: body.organizationId, projectId: body.projectId, goalId, actorId: actor.actorId, expectedGoalVersion: Number(body.expectedGoalVersion), reason: String(body.reason ?? "") });
      return withSecurityHeaders(Response.json({ data: receipt }, { status: 201 }));
    } catch (error) { return mapError(error); }
  };
}
