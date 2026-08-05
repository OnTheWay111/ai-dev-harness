import { AuthorizationDeniedError } from "../../auth/rbac-policy.ts";
import {
  assertSameOrigin,
  defaultWriteRateLimiter,
  readJsonBody,
  RequestSecurityError,
  withSecurityHeaders,
  type RateLimiter,
} from "../../security/request-security.ts";
import type { AcceptanceVerificationPlanService } from
  "../application/acceptance-verification-plan-service.ts";
import type { DeliveryReportService } from
  "../application/delivery-report-service.ts";
import type { GoalVerificationService } from
  "../application/goal-verification-service.ts";
import type { VerificationGapService } from
  "../application/verification-gap-service.ts";
import { AcceptanceVerificationPlanValidationError } from
  "../domain/acceptance-verification.ts";
import { GoalVerifierContractError } from
  "../domain/goal-verification.ts";

class AuthenticationRequiredError extends Error {}
class VerificationRequestError extends Error {}

function failure(code: string, status: number) {
  return withSecurityHeaders(Response.json({
    error: {
      code,
      message: "The Goal verification operation was not completed",
      preservedState:
        "Existing verification plans, evidence, gap reports, and Delivery Reports remain immutable",
    },
  }, {
    status,
    headers: { "cache-control": "private, no-store" },
  }));
}

function mapError(error: unknown): Response {
  if (error instanceof RequestSecurityError) return failure(error.code, error.status);
  if (error instanceof AuthenticationRequiredError) {
    return failure("authentication_required", 401);
  }
  if (error instanceof AuthorizationDeniedError) return failure("forbidden", 403);
  if (error instanceof AcceptanceVerificationPlanValidationError ||
    error instanceof GoalVerifierContractError ||
    error instanceof VerificationRequestError || error instanceof TypeError) {
    return failure("validation_failed", 400);
  }
  if (error instanceof Error && /conflict|stale|latest/i.test(error.message)) {
    return failure("version_conflict", 409);
  }
  return failure("internal_error", 500);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VerificationRequestError("object body required");
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new VerificationRequestError("unknown body field");
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function manualEvidence(value: unknown): readonly {
  entryId: string;
  evidenceRef: string;
  reason: string;
}[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new VerificationRequestError("manualEvidence must be a bounded array");
  }
  return value.map((item, index) => {
    const evidence = record(item);
    exactFields(evidence, ["entryId", "evidenceRef", "reason"]);
    const fields = ["entryId", "evidenceRef", "reason"] as const;
    for (const field of fields) {
      const candidate = evidence[field];
      if (typeof candidate !== "string" || !candidate.trim() ||
        candidate.trim().length > (field === "reason" ? 4_000 : 2_000)) {
        throw new VerificationRequestError(
          `manualEvidence[${index}].${field} is invalid`,
        );
      }
    }
    return {
      entryId: (evidence.entryId as string).trim(),
      evidenceRef: (evidence.evidenceRef as string).trim(),
      reason: (evidence.reason as string).trim(),
    };
  });
}

function knownRisks(value: unknown): readonly {
  severity: "low" | "medium" | "high" | "critical";
  statement: string;
  disposition: "accepted" | "monitor" | "blocked";
}[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new VerificationRequestError("knownRisks must be a bounded array");
  }
  return value.map((item, index) => {
    const risk = record(item);
    exactFields(risk, ["severity", "statement", "disposition"]);
    if (!["low", "medium", "high", "critical"].includes(String(risk.severity)) ||
      !["accepted", "monitor", "blocked"].includes(String(risk.disposition)) ||
      typeof risk.statement !== "string" || !risk.statement.trim() ||
      risk.statement.trim().length > 4_000) {
      throw new VerificationRequestError(`knownRisks[${index}] is invalid`);
    }
    return {
      severity: risk.severity as "low" | "medium" | "high" | "critical",
      statement: risk.statement.trim(),
      disposition: risk.disposition as "accepted" | "monitor" | "blocked",
    };
  });
}

function scope(value: Record<string, unknown>, goalId: string) {
  if (!validId(value.organizationId) || !validId(value.projectId) ||
    !validId(goalId)) {
    throw new VerificationRequestError("valid Goal scope is required");
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
  )) throw new VerificationRequestError("unknown query field");
  return scope({
    organizationId: url.searchParams.get("organizationId"),
    projectId: url.searchParams.get("projectId"),
  }, goalId);
}

function header(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value || value.length > 200) {
    throw new VerificationRequestError(`${name} is required`);
  }
  return value;
}

export function createGoalVerificationHandlers(input: {
  plans: Pick<AcceptanceVerificationPlanService, "compile" | "timeline">;
  verifications: Pick<GoalVerificationService, "verify" | "timeline">;
  gaps: Pick<VerificationGapService, "create" | "confirm" | "timeline">;
  reports: Pick<DeliveryReportService, "generate" | "accept" | "export" | "timeline">;
  actorResolver(request: Request): Promise<{ actorId: string } | null>;
  allowedOrigins?: readonly string[];
  rateLimiter?: RateLimiter;
}) {
  const actor = async (request: Request) => {
    const resolved = await input.actorResolver(request);
    if (!resolved) throw new AuthenticationRequiredError();
    return resolved;
  };
  const read = async (request: Request, goalId: string) => ({
    ...(await actor(request)),
    ...queryScope(request, goalId),
  });
  const write = async (request: Request, goalId: string) => {
    assertSameOrigin(request, input.allowedOrigins);
    const identity = await actor(request);
    const body = record(await readJsonBody(request, 256 * 1024));
    return {
      actorId: identity.actorId,
      requestId: header(request, "x-request-id"),
      idempotencyKey: header(request, "idempotency-key"),
      body,
      scope: scope(body, goalId),
    };
  };
  const rate = (actorId: string, organizationId: string, endpoint: string) =>
    (input.rateLimiter ?? defaultWriteRateLimiter).consume({
      actorId,
      organizationId,
      endpoint,
    });

  return {
    plans: async (request: Request, goalId: string) => {
      try {
        if (request.method === "GET") {
          return withSecurityHeaders(Response.json({
            data: await input.plans.timeline(await read(request, goalId)),
          }, { headers: { "cache-control": "private, no-store" } }));
        }
        if (request.method !== "POST") return failure("not_found", 404);
        const command = await write(request, goalId);
        exactFields(command.body, [
          "organizationId", "projectId", "issuePlanId",
          "expectedGoalVersion", "expectedIssuePlanVersion", "draft",
        ]);
        if (!validId(command.body.issuePlanId) ||
          !Number.isInteger(command.body.expectedGoalVersion) ||
          !Number.isInteger(command.body.expectedIssuePlanVersion)) {
          throw new VerificationRequestError("verification plan source is invalid");
        }
        rate(command.actorId, command.scope.organizationId, "goal.verify.plan");
        return withSecurityHeaders(Response.json({
          data: await input.plans.compile({
            ...command.scope,
            issuePlanId: command.body.issuePlanId,
            expectedGoalVersion: command.body.expectedGoalVersion as number,
            expectedIssuePlanVersion:
              command.body.expectedIssuePlanVersion as number,
            actorId: command.actorId,
            draft: command.body.draft,
          }),
        }));
      } catch (error) {
        return mapError(error);
      }
    },

    verifications: async (request: Request, goalId: string) => {
      try {
        if (request.method === "GET") {
          return withSecurityHeaders(Response.json({
            data: await input.verifications.timeline(await read(request, goalId)),
          }, { headers: { "cache-control": "private, no-store" } }));
        }
        if (request.method !== "POST") return failure("not_found", 404);
        const command = await write(request, goalId);
        exactFields(command.body, [
          "organizationId", "projectId", "planId", "expectedGoalVersion",
          "manualEvidence",
        ]);
        if (!validId(command.body.planId) ||
          !Number.isInteger(command.body.expectedGoalVersion)) {
          throw new VerificationRequestError("Goal verification input is invalid");
        }
        const evidence = manualEvidence(command.body.manualEvidence);
        rate(command.actorId, command.scope.organizationId, "goal.verify.run");
        return withSecurityHeaders(Response.json({
          data: await input.verifications.verify({
            ...command.scope,
            planId: command.body.planId,
            expectedGoalVersion: command.body.expectedGoalVersion as number,
            actorId: command.actorId,
            manualEvidence: evidence,
          }),
        }));
      } catch (error) {
        return mapError(error);
      }
    },

    gaps: async (request: Request, goalId: string) => {
      try {
        if (request.method === "GET") {
          return withSecurityHeaders(Response.json({
            data: await input.gaps.timeline(await read(request, goalId)),
          }, { headers: { "cache-control": "private, no-store" } }));
        }
        if (request.method !== "POST") return failure("not_found", 404);
        const command = await write(request, goalId);
        exactFields(command.body, ["organizationId", "projectId", "verificationId"]);
        if (!validId(command.body.verificationId)) {
          throw new VerificationRequestError("verificationId is invalid");
        }
        rate(command.actorId, command.scope.organizationId, "goal.verify.gap");
        return withSecurityHeaders(Response.json({
          data: await input.gaps.create({
            ...command.scope,
            verificationId: command.body.verificationId,
            actorId: command.actorId,
          }),
        }));
      } catch (error) {
        return mapError(error);
      }
    },

    remediation: async (request: Request, goalId: string, reportId: string) => {
      try {
        if (request.method !== "POST" || !validId(reportId)) {
          return failure("not_found", 404);
        }
        const command = await write(request, goalId);
        exactFields(command.body, [
          "organizationId", "projectId", "humanConfirmed", "reason", "draft",
        ]);
        if (command.body.humanConfirmed !== true ||
          typeof command.body.reason !== "string") {
          throw new VerificationRequestError("confirmed remediation is required");
        }
        rate(command.actorId, command.scope.organizationId, "goal.verify.remediate");
        return withSecurityHeaders(Response.json({
          data: await input.gaps.confirm({
            ...command.scope,
            reportId,
            actorId: command.actorId,
            humanConfirmed: true,
            reason: command.body.reason,
            idempotencyKey: command.idempotencyKey,
            draft: command.body.draft,
          }),
        }));
      } catch (error) {
        return mapError(error);
      }
    },

    reports: async (request: Request, goalId: string) => {
      try {
        if (request.method === "GET") {
          return withSecurityHeaders(Response.json({
            data: await input.reports.timeline(await read(request, goalId)),
          }, { headers: { "cache-control": "private, no-store" } }));
        }
        if (request.method !== "POST") return failure("not_found", 404);
        const command = await write(request, goalId);
        exactFields(command.body, [
          "organizationId", "projectId", "verificationId", "knownRisks",
        ]);
        if (!validId(command.body.verificationId)) {
          throw new VerificationRequestError("Delivery Report input is invalid");
        }
        const risks = knownRisks(command.body.knownRisks);
        rate(command.actorId, command.scope.organizationId, "delivery_report.generate");
        return withSecurityHeaders(Response.json({
          data: await input.reports.generate({
            ...command.scope,
            verificationId: command.body.verificationId,
            actorId: command.actorId,
            knownRisks: risks,
          }),
        }));
      } catch (error) {
        return mapError(error);
      }
    },

    reportAcceptance: async (
      request: Request,
      goalId: string,
      reportId: string,
    ) => {
      try {
        if (request.method !== "POST" || !validId(reportId)) {
          return failure("not_found", 404);
        }
        const command = await write(request, goalId);
        exactFields(command.body, [
          "organizationId", "projectId", "expectedGoalVersion", "reason",
        ]);
        if (!Number.isInteger(command.body.expectedGoalVersion) ||
          typeof command.body.reason !== "string") {
          throw new VerificationRequestError("Delivery acceptance input is invalid");
        }
        rate(command.actorId, command.scope.organizationId, "goal.accept");
        return withSecurityHeaders(Response.json({
          data: await input.reports.accept({
            ...command.scope,
            reportId,
            actorId: command.actorId,
            expectedGoalVersion: command.body.expectedGoalVersion as number,
            reason: command.body.reason,
            requestId: command.requestId,
            idempotencyKey: command.idempotencyKey,
          }),
        }));
      } catch (error) {
        return mapError(error);
      }
    },

    reportExport: async (request: Request, goalId: string, reportId: string) => {
      try {
        if (request.method !== "GET" || !validId(reportId)) {
          return failure("not_found", 404);
        }
        const result = await input.reports.export({
          ...await read(request, goalId),
          reportId,
        });
        return withSecurityHeaders(new Response(result.body, {
          headers: {
            "content-type": `${result.mediaType}; charset=utf-8`,
            "content-disposition": `attachment; filename="${result.fileName}"`,
            "cache-control": "private, no-store",
          },
        }));
      } catch (error) {
        return mapError(error);
      }
    },
  };
}
