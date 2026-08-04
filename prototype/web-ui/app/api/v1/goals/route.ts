import { readRequestPrincipal } from "../../../auth/oidc-http.ts";
import { getOidcService } from "../../../auth/oidc-runtime.ts";
import { getGoalWorkspaceService } from
  "../../../control-plane/runtime/goal-workspace-runtime.ts";
import { createGoalWorkspaceHandler } from
  "../../../control-plane/http/goal-workspace-handler.ts";

const handle = createGoalWorkspaceHandler({
  service: getGoalWorkspaceService(),
  actorResolver: async (request) => {
    const principal = await readRequestPrincipal(request, getOidcService());
    return principal ? { actorId: principal.actorId } : null;
  },
});

export async function POST(request: Request): Promise<Response> {
  return await handle(request);
}
