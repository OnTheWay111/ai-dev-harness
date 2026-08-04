import { readRequestPrincipal } from "../../../../../auth/oidc-http.ts";
import { getOidcService } from "../../../../../auth/oidc-runtime.ts";
import { createGoalTransitionHandler } from
  "../../../../../control-plane/http/goal-transition-handler.ts";
import { getGoalTransitionService } from
  "../../../../../control-plane/runtime/goal-transition-runtime.ts";
import { configuredWriteOrigins, withSecurityHeaders } from
  "../../../../../security/request-security.ts";

const handle = createGoalTransitionHandler({
  service: getGoalTransitionService(),
  allowedOrigins: configuredWriteOrigins(),
  actorResolver: async (request) => {
    const principal = await readRequestPrincipal(request, getOidcService());
    return principal ? { actorId: principal.actorId } : null;
  },
});

interface Context { params: Promise<{ goalId: string }> }

function validId(value: string | null): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

export async function POST(request: Request, context: Context) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const projectId = url.searchParams.get("projectId");
  const goalId = (await context.params).goalId;
  if (!validId(organizationId) || !validId(projectId) || !validId(goalId) ||
    [...url.searchParams.keys()].some((key) =>
      !["organizationId", "projectId"].includes(key)
    )) {
    return withSecurityHeaders(Response.json({
      error: {
        code: "validation_failed",
        message: "The Goal transition was not committed",
      },
    }, { status: 400 }));
  }
  return await handle(request, { organizationId, projectId, goalId });
}
