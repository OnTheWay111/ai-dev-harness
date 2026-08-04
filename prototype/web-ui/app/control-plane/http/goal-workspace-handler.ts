import {
  GoalWorkspaceNotFoundError,
  GoalWorkspaceValidationError,
  type CreateGoalCommand,
  type ReadGoalCommand,
  type UpdateGoalCommand,
} from "../application/goal-workspace-service.ts";
import type { GoalContract, GoalContractDraft } from
  "../domain/goal-contract.ts";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import type { GoalWorkspaceReceipt } from
  "../ports/goal-workspace-repository.ts";
import { AuthorizationDeniedError } from "../../auth/rbac-policy.ts";
import {
  assertSameOrigin,
  defaultWriteRateLimiter,
  readJsonBody,
  RequestSecurityError,
  withSecurityHeaders,
  type RateLimiter,
} from "../../security/request-security.ts";

interface GoalWorkspaceApplication {
  create(command: CreateGoalCommand): Promise<GoalWorkspaceReceipt>;
  get(command: ReadGoalCommand): Promise<GoalContract>;
  update(command: UpdateGoalCommand): Promise<GoalWorkspaceReceipt>;
}

interface HandlerDependencies {
  service: GoalWorkspaceApplication;
  actorResolver(request: Request): Promise<{ actorId: string } | null>;
  rateLimiter?: RateLimiter;
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
}

function errorResponse(code: string, status: number): Response {
  return withSecurityHeaders(Response.json({
    error: {
      code,
      message: "The Goal Contract request was not completed",
      impact: "No unconfirmed Goal Contract changes were accepted",
      preservedState: "The last committed Goal version remains authoritative",
      nextAction: status === 409
        ? "Reload the Goal and retry against its current version"
        : "Correct the request or request project access, then retry",
    },
  }, { status, headers: { "cache-control": "private, no-store" } }));
}

function securityErrorResponse(error: RequestSecurityError): Response {
  const response = errorResponse(error.code, error.status);
  if (error.retryAfterSeconds) {
    response.headers.set("retry-after", String(error.retryAfterSeconds));
  }
  return response;
}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoalWorkspaceValidationError("request body must be an object");
  }
  const record = value as Record<string, unknown>;
  const fields = new Set(allowed);
  if (Object.keys(record).some((field) => !fields.has(field))) {
    throw new GoalWorkspaceValidationError("request contains an unknown field");
  }
  return record;
}

function parseScope(record: Record<string, unknown>) {
  const organizationId = record.organizationId;
  const projectId = record.projectId;
  if (
    typeof organizationId !== "string" ||
    typeof projectId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(organizationId) ||
    !/^[0-9a-f-]{36}$/i.test(projectId)
  ) {
    throw new GoalWorkspaceValidationError("organizationId and projectId are required");
  }
  return { organizationId, projectId };
}

function parseDraft(value: unknown): GoalContractDraft {
  const draft = object(value, [
    "title",
    "problemStatement",
    "desiredOutcome",
    "acceptanceCriteria",
    "nonGoals",
    "constraints",
  ]);
  return draft as unknown as GoalContractDraft;
}

function requestIdentity(request: Request) {
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(idempotencyKey)) {
    throw new GoalWorkspaceValidationError("Idempotency-Key is required");
  }
  const suppliedRequestId = request.headers.get("x-request-id");
  if (suppliedRequestId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(suppliedRequestId)) {
    throw new GoalWorkspaceValidationError("X-Request-Id is invalid");
  }
  return {
    idempotencyKey,
    requestId: suppliedRequestId ?? crypto.randomUUID(),
  };
}

function mapError(error: unknown): Response {
  if (error instanceof RequestSecurityError) return securityErrorResponse(error);
  if (error instanceof AuthorizationDeniedError) return errorResponse("forbidden", 403);
  if (error instanceof GoalWorkspaceNotFoundError) return errorResponse("not_found", 404);
  if (error instanceof VersionConflictError) return errorResponse("version_conflict", 409);
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof IdempotencyInProgressError
  ) return errorResponse("idempotency_conflict", 409);
  if (error instanceof GoalWorkspaceValidationError) {
    return errorResponse("validation_failed", 400);
  }
  return errorResponse("internal_error", 500);
}

export function createGoalWorkspaceHandler(dependencies: HandlerDependencies) {
  return async function handle(request: Request, goalId?: string): Promise<Response> {
    try {
      if (request.method === "GET" && goalId) {
        const actor = await dependencies.actorResolver(request);
        if (!actor) return errorResponse("authentication_required", 401);
        const url = new URL(request.url);
        const allowed = new Set(["organizationId", "projectId"]);
        if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
          throw new GoalWorkspaceValidationError("query contains an unknown field");
        }
        const scope = parseScope({
          organizationId: url.searchParams.get("organizationId"),
          projectId: url.searchParams.get("projectId"),
        });
        const goal = await dependencies.service.get({ ...scope, goalId, actorId: actor.actorId });
        return withSecurityHeaders(Response.json({ data: goal }, {
          headers: { "cache-control": "private, no-store" },
        }));
      }

      if (request.method !== "POST" && request.method !== "PATCH") {
        return errorResponse("not_found", 404);
      }
      assertSameOrigin(request, dependencies.allowedOrigins);
      const actor = await dependencies.actorResolver(request);
      if (!actor) return errorResponse("authentication_required", 401);
      const endpoint = request.method === "POST" ? "goal.create" : "goal.update";
      const body = object(await readJsonBody(
        request,
        dependencies.maxBodyBytes ?? 32 * 1024,
      ), request.method === "POST"
        ? ["organizationId", "projectId", "draft", "reason"]
        : ["organizationId", "projectId", "expectedVersion", "draft", "reason"]);
      const scope = parseScope(body);
      (dependencies.rateLimiter ?? defaultWriteRateLimiter).consume({
        actorId: actor.actorId,
        organizationId: scope.organizationId,
        endpoint,
      });
      const identity = requestIdentity(request);
      const reason = typeof body.reason === "string" ? body.reason : "";
      const draft = parseDraft(body.draft);
      if (request.method === "POST") {
        const receipt = await dependencies.service.create({
          ...scope,
          ...identity,
          actorId: actor.actorId,
          reason,
          draft,
        });
        return withSecurityHeaders(Response.json({ data: receipt }, { status: 201 }));
      }
      if (!goalId) return errorResponse("not_found", 404);
      if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
        throw new GoalWorkspaceValidationError("expectedVersion must be positive");
      }
      const receipt = await dependencies.service.update({
        ...scope,
        ...identity,
        goalId,
        actorId: actor.actorId,
        expectedVersion: Number(body.expectedVersion),
        reason,
        draft,
      });
      return withSecurityHeaders(Response.json({ data: receipt }));
    } catch (error) {
      return mapError(error);
    }
  };
}
