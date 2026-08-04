import { AuthorizationDeniedError } from "../../auth/rbac-policy.ts";
import {
  assertSameOrigin,
  defaultWriteRateLimiter,
  readJsonBody,
  RequestSecurityError,
  withSecurityHeaders,
  type RateLimiter,
} from "../../security/request-security.ts";
import type {
  AnswerClarificationCommand,
  GenerateClarificationsCommand,
} from "../application/clarification-history-service.ts";
import {
  ClarificationExpiredError,
  ClarificationNotFoundError,
  ClarificationValidationError,
  type ClarificationAnswerReceipt,
  type ClarificationGenerationReceipt,
  type ClarificationTimeline,
} from "../domain/clarification-history.ts";
import { VersionConflictError } from "../domain/errors.ts";

interface Application {
  timeline(command: { organizationId: string; projectId: string; goalId: string; actorId: string }): Promise<ClarificationTimeline>;
  generate(command: GenerateClarificationsCommand): Promise<ClarificationGenerationReceipt>;
  answer(command: AnswerClarificationCommand): Promise<ClarificationAnswerReceipt>;
}

function response(code: string, status: number) {
  return withSecurityHeaders(Response.json({ error: {
    code,
    message: "The clarification request was not completed",
    preservedState: "All committed rounds, answers, and decisions remain unchanged",
  } }, { status, headers: { "cache-control": "private, no-store" } }));
}

function mapError(error: unknown) {
  if (error instanceof RequestSecurityError) return response(error.code, error.status);
  if (error instanceof AuthorizationDeniedError) return response("forbidden", 403);
  if (error instanceof ClarificationNotFoundError) return response("not_found", 404);
  if (error instanceof ClarificationExpiredError) return response("question_expired", 409);
  if (error instanceof VersionConflictError) return response("version_conflict", 409);
  if (error instanceof ClarificationValidationError) return response("validation_failed", 400);
  return response("internal_error", 500);
}

function object(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClarificationValidationError("request body must be an object");
  }
  const record = value as Record<string, unknown>;
  const fields = new Set(allowed);
  if (Object.keys(record).some((field) => !fields.has(field))) {
    throw new ClarificationValidationError("request contains an unknown field");
  }
  return record;
}

function scope(record: Record<string, unknown>, goalId: string) {
  const organizationId = record.organizationId;
  const projectId = record.projectId;
  if (typeof organizationId !== "string" || typeof projectId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(organizationId) || !/^[0-9a-f-]{36}$/i.test(projectId) ||
      !/^[0-9a-f-]{36}$/i.test(goalId)) {
    throw new ClarificationValidationError("valid scope identifiers are required");
  }
  return { organizationId, projectId, goalId };
}

export function createClarificationHistoryHandler(input: {
  service: Application;
  actorResolver(request: Request): Promise<{ actorId: string } | null>;
  rateLimiter?: RateLimiter;
  allowedOrigins?: readonly string[];
}) {
  return async (request: Request, goalId: string, threadId?: string) => {
    try {
      if (request.method === "GET") {
        const actor = await input.actorResolver(request);
        if (!actor) return response("authentication_required", 401);
        const url = new URL(request.url);
        if ([...url.searchParams.keys()].some((key) => !["organizationId", "projectId"].includes(key))) {
          throw new ClarificationValidationError("query contains an unknown field");
        }
        const commandScope = scope({ organizationId: url.searchParams.get("organizationId"), projectId: url.searchParams.get("projectId") }, goalId);
        const timeline = await input.service.timeline({ ...commandScope, actorId: actor.actorId });
        return withSecurityHeaders(Response.json({ data: timeline }, { headers: { "cache-control": "private, no-store" } }));
      }
      if (request.method !== "POST") return response("not_found", 404);
      assertSameOrigin(request, input.allowedOrigins);
      const actor = await input.actorResolver(request);
      if (!actor) return response("authentication_required", 401);
      const body = object(await readJsonBody(request, 32 * 1024), threadId
        ? ["organizationId", "projectId", "expectedGoalVersion", "expectedQuestionRevision", "answer", "reason"]
        : ["organizationId", "projectId", "expectedGoalVersion", "reason"]);
      const commandScope = scope(body, goalId);
      (input.rateLimiter ?? defaultWriteRateLimiter).consume({ actorId: actor.actorId, organizationId: commandScope.organizationId, endpoint: threadId ? "clarification.answer" : "clarification.generate" });
      if (threadId) {
        const result = await input.service.answer({ ...commandScope, threadId, actorId: actor.actorId, expectedGoalVersion: Number(body.expectedGoalVersion), expectedQuestionRevision: Number(body.expectedQuestionRevision), answer: String(body.answer ?? ""), reason: String(body.reason ?? "") });
        return withSecurityHeaders(Response.json({ data: result }, { status: 201 }));
      }
      const result = await input.service.generate({ ...commandScope, actorId: actor.actorId, expectedGoalVersion: Number(body.expectedGoalVersion), reason: String(body.reason ?? "") });
      return withSecurityHeaders(Response.json({ data: result }, { status: 201 }));
    } catch (error) { return mapError(error); }
  };
}
