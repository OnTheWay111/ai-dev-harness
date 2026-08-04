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
} from "../domain/state-machines.ts";
import type { GoalStatus, TransitionGuard } from
  "../domain/state-machines.ts";

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
  actorResolver(request: Request): Promise<Actor>;
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
  return {
    expectedVersion: Number(body.expectedVersion),
    nextState: body.nextState as GoalStatus,
    reason: typeof body.reason === "string" ? body.reason : "",
    guards: (body.guards ?? {}) as Partial<Record<TransitionGuard, boolean>>,
  };
}

function errorResponse(code: string, status: number): Response {
  return Response.json(
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
  );
}

export function createGoalTransitionHandler(dependencies: HandlerDependencies) {
  return async function goalTransitionHandler(
    request: Request,
    scope: GoalRouteScope,
  ): Promise<Response> {
    try {
      if (request.method !== "POST") return errorResponse("not_found", 404);
      const actor = await dependencies.actorResolver(request);
      const body = parseBody(await request.json());
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      if (!idempotencyKey) {
        throw new CommandValidationError("Idempotency-Key is required");
      }
      const receipt = await dependencies.service.transition({
        ...scope,
        actorId: actor.actorId,
        requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
        idempotencyKey,
        ...body,
      });
      return Response.json({ data: receipt }, { status: 200 });
    } catch (error) {
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
