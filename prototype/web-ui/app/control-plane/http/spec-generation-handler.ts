import { AuthorizationDeniedError } from "../../auth/rbac-policy.ts";
import {
  assertSameOrigin,
  defaultWriteRateLimiter,
  readJsonBody,
  RequestSecurityError,
  withSecurityHeaders,
  type RateLimiter,
} from "../../security/request-security.ts";
import type { SpecGenerationService } from
  "../application/spec-generation-service.ts";
import { SpecGenerationValidationError } from
  "../application/spec-generation-service.ts";
import { ClarificationExpiredError } from
  "../domain/clarification-history.ts";
import { VersionConflictError } from "../domain/errors.ts";
import { SpecBundleValidationError } from "../domain/spec-artifact.ts";
import { ArtifactIntegrityError } from
  "../adapters/filesystem-artifact-store.ts";

function failure(code: string, status: number) {
  return withSecurityHeaders(Response.json({
    error: {
      code,
      message: "The specification request was not completed",
      preservedState: "Previously committed immutable SpecRevisions remain authoritative",
    },
  }, { status, headers: { "cache-control": "private, no-store" } }));
}

function mapError(error: unknown): Response {
  if (error instanceof RequestSecurityError) return failure(error.code, error.status);
  if (error instanceof AuthorizationDeniedError) return failure("forbidden", 403);
  if (error instanceof ClarificationExpiredError || error instanceof VersionConflictError) {
    return failure("version_conflict", 409);
  }
  if (
    error instanceof SpecGenerationValidationError ||
    error instanceof SpecBundleValidationError
  ) return failure("validation_failed", 400);
  if (error instanceof ArtifactIntegrityError) return failure("artifact_integrity_failed", 503);
  return failure("internal_error", 500);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

export function createSpecGenerationHandler(input: {
  service: Pick<SpecGenerationService, "generate" | "timeline">;
  actorResolver(request: Request): Promise<{ actorId: string } | null>;
  rateLimiter?: RateLimiter;
  allowedOrigins?: readonly string[];
}) {
  return async (request: Request, goalId: string): Promise<Response> => {
    try {
      if (request.method === "GET") {
        const actor = await input.actorResolver(request);
        if (!actor) return failure("authentication_required", 401);
        const url = new URL(request.url);
        if ([...url.searchParams.keys()].some((key) =>
          !["organizationId", "projectId"].includes(key)
        )) throw new SpecGenerationValidationError("unknown query field");
        const organizationId = url.searchParams.get("organizationId");
        const projectId = url.searchParams.get("projectId");
        if (!validId(organizationId) || !validId(projectId) || !validId(goalId)) {
          throw new SpecGenerationValidationError("valid scope is required");
        }
        const timeline = await input.service.timeline({
          organizationId,
          projectId,
          goalId,
          actorId: actor.actorId,
        });
        return withSecurityHeaders(Response.json(
          { data: timeline },
          { headers: { "cache-control": "private, no-store" } },
        ));
      }
      if (request.method !== "POST") return failure("not_found", 404);
      assertSameOrigin(request, input.allowedOrigins);
      const actor = await input.actorResolver(request);
      if (!actor) return failure("authentication_required", 401);
      const value = await readJsonBody(request, 16 * 1024);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SpecGenerationValidationError("object body required");
      }
      const body = value as Record<string, unknown>;
      if (Object.keys(body).some((key) =>
        !["organizationId", "projectId", "expectedGoalVersion", "reason"].includes(key)
      )) throw new SpecGenerationValidationError("unknown body field");
      if (!validId(body.organizationId) || !validId(body.projectId) || !validId(goalId)) {
        throw new SpecGenerationValidationError("valid scope is required");
      }
      (input.rateLimiter ?? defaultWriteRateLimiter).consume({
        actorId: actor.actorId,
        organizationId: body.organizationId,
        endpoint: "spec.generate",
      });
      const receipt = await input.service.generate({
        organizationId: body.organizationId,
        projectId: body.projectId,
        goalId,
        actorId: actor.actorId,
        expectedGoalVersion: Number(body.expectedGoalVersion),
        reason: String(body.reason ?? ""),
      });
      return withSecurityHeaders(Response.json({ data: receipt }, { status: 201 }));
    } catch (error) {
      return mapError(error);
    }
  };
}
