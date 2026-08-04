import {
  GoalNotFoundError,
} from "../application/goal-application-service.ts";
import type {
  GoalTransitionCommand,
  GoalTransitionReceipt,
} from "../application/goal-application-service.ts";
import {
  CommandValidationError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import {
  DomainTransitionError,
  goalStatuses,
  transitionGuards,
} from "../domain/state-machines.ts";
import type { GoalStatus, TransitionGuard } from
  "../domain/state-machines.ts";
import {
  assertSameOrigin,
  defaultWriteRateLimiter,
  readJsonBody,
  RequestSecurityError,
  withSecurityHeaders,
  type RateLimiter,
} from "../../security/request-security.ts";

interface GoalApplication {
  transition(command: GoalTransitionCommand): Promise<GoalTransitionReceipt>;
}

interface Actor {
  actorId: string;
}

interface GoalRouteScope {
  organizationId: string;
  projectId: string;
  goalId: string;
}

interface HandlerDependencies {
  service: GoalApplication;
  actorResolver(request: Request): Promise<Actor | null>;
  rateLimiter?: RateLimiter;
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
}

interface GoalTransitionBody {
  expectedVersion: number;
  nextState: GoalStatus;
  reason: string;
  guards: Partial<Record<TransitionGuard, boolean>>;
}

function parseBody(value: unknown): GoalTransitionBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid request body");
  }
  const body = value as Record<string, unknown>;
  const allowedFields = new Set([
    "expectedVersion",
    "nextState",
    "reason",
    "guards",
  ]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    throw new Error("unknown request field");
  }
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
    throw new Error("expectedVersion must be a positive integer");
  }
  if (
    typeof body.nextState !== "string" ||
    !goalStatuses.includes(body.nextState as GoalStatus)
  ) {
    throw new Error("nextState is invalid");
  }
  if (
    body.reason !== undefined &&
    (typeof body.reason !== "string" || body.reason.length > 4000)
  ) {
    throw new Error("reason is invalid");
  }
  if (
    body.guards !== undefined &&
    (!body.guards || typeof body.guards !== "object" || Array.isArray(body.guards))
  ) {
    throw new Error("guards are invalid");
  }
  const guards = (body.guards ?? {}) as Record<string, unknown>;
  if (
    Object.entries(guards).some(([guard, enabled]) =>
      !transitionGuards.includes(guard as TransitionGuard) ||
      typeof enabled !== "boolean"
    )
  ) {
    throw new Error("guards are invalid");
  }
  return {
    expectedVersion: Number(body.expectedVersion),
    nextState: body.nextState as GoalStatus,
    reason: typeof body.reason === "string" ? body.reason : "",
    guards: guards as Partial<Record<TransitionGuard, boolean>>,
  };
}

function errorResponse(code: string, status: number): Response {
  return withSecurityHeaders(Response.json(
    {
      error: {
        code,
        message: "The Goal transition was not committed",
        impact: "The authoritative Goal state is unchanged",
        preservedState: "No state or event was partially written",
        nextAction: status === 409
          ? "Reload the Goal and retry against the current version"
          : "Correct the request and retry",
      },
    },
    { status },
  ));
}

function securityErrorResponse(error: RequestSecurityError): Response {
  const response = errorResponse(error.code, error.status);
  if (error.retryAfterSeconds) {
    response.headers.set("retry-after", String(error.retryAfterSeconds));
  }
  return response;
}

export function createGoalTransitionHandler(dependencies: HandlerDependencies) {
  return async function goalTransitionHandler(
    request: Request,
    scope: GoalRouteScope,
  ): Promise<Response> {
    try {
      if (request.method !== "POST") return errorResponse("not_found", 404);
      assertSameOrigin(request, dependencies.allowedOrigins);
      const actor = await dependencies.actorResolver(request);
      if (!actor) return errorResponse("authentication_required", 401);
      (dependencies.rateLimiter ?? defaultWriteRateLimiter).consume({
        actorId: actor.actorId,
        organizationId: scope.organizationId,
        endpoint: "goal.transition",
      });
      const body = parseBody(await readJsonBody(
        request,
        dependencies.maxBodyBytes ?? 16 * 1024,
      ));
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(idempotencyKey)) {
        throw new CommandValidationError("Idempotency-Key is required");
      }
      const suppliedRequestId = request.headers.get("x-request-id");
      if (
        suppliedRequestId &&
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(suppliedRequestId)
      ) {
        throw new CommandValidationError("X-Request-Id is invalid");
      }
      const receipt = await dependencies.service.transition({
        ...scope,
        actorId: actor.actorId,
        requestId: suppliedRequestId ?? crypto.randomUUID(),
        idempotencyKey,
        ...body,
      });
      return withSecurityHeaders(
        Response.json({ data: receipt }, { status: 200 }),
      );
    } catch (error) {
      if (error instanceof RequestSecurityError) {
        return securityErrorResponse(error);
      }
      if (error instanceof VersionConflictError) {
        return errorResponse("version_conflict", 409);
      }
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof IdempotencyInProgressError
      ) {
        return errorResponse("idempotency_conflict", 409);
      }
      if (error instanceof DomainTransitionError) {
        return errorResponse(error.code === "version_conflict"
          ? "version_conflict"
          : "invalid_transition", 409);
      }
      if (error instanceof GoalNotFoundError) {
        return errorResponse("not_found", 404);
      }
      if (error instanceof CommandValidationError) {
        return errorResponse("validation_failed", 400);
      }
      return errorResponse("validation_failed", 400);
    }
  };
}
