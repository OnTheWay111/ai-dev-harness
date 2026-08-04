import { readRequestPrincipal } from "../../../../auth/oidc-http.ts";
import { getOidcService } from "../../../../auth/oidc-runtime.ts";
import { getGoalWorkspaceService } from
  "../../../../control-plane/runtime/goal-workspace-runtime.ts";
import { createGoalWorkspaceHandler } from
  "../../../../control-plane/http/goal-workspace-handler.ts";
import { configuredWriteOrigins } from "../../../../security/request-security.ts";

const handle = createGoalWorkspaceHandler({
  service: getGoalWorkspaceService(),
  allowedOrigins: configuredWriteOrigins(),
  actorResolver: async (request) => {
    const principal = await readRequestPrincipal(request, getOidcService());
    return principal ? { actorId: principal.actorId } : null;
  },
});

interface RouteContext {
  params: Promise<{ goalId: string }>;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return await handle(request, (await context.params).goalId);
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return await handle(request, (await context.params).goalId);
}
