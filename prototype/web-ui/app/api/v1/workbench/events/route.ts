import { readRequestPrincipal } from
  "../../../../auth/oidc-http.ts";
import { getOidcService } from
  "../../../../auth/oidc-runtime.ts";
import { hasVisibleProjects } from
  "../../../../auth/visibility-scope.ts";
import { withSecurityHeaders } from
  "../../../../security/request-security.ts";
import { createWorkbenchEventsHandler } from
  "../../../../workbench/server/workbench-events.ts";
import {
  getWorkbenchRepository,
  getWorkbenchVisibilityResolver,
} from "../../../../workbench/server/workbench-repository-factory.ts";

const handler = createWorkbenchEventsHandler({
  async resolveRevision(request) {
    const principal = await readRequestPrincipal(request, getOidcService());
    if (!principal) return null;
    const visibility = await getWorkbenchVisibilityResolver().resolve(principal.actorId);
    if (!hasVisibleProjects(visibility)) return null;
    const result = await getWorkbenchRepository().getWorkbench(
      visibility,
      { limit: 1 },
    );
    return {
      revision: result.data.revision,
      generatedAt: result.data.generatedAt,
    };
  },
});

export async function GET(request: Request): Promise<Response> {
  return withSecurityHeaders(await handler(request));
}
