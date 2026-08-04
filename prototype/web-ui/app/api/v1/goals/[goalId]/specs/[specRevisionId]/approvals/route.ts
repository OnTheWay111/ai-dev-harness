import { readRequestPrincipal } from "../../../../../../../auth/oidc-http.ts";
import { getOidcService } from "../../../../../../../auth/oidc-runtime.ts";
import { createSpecApprovalHandler } from
  "../../../../../../../control-plane/http/spec-approval-handler.ts";
import { getSpecApprovalService } from
  "../../../../../../../control-plane/runtime/spec-approval-runtime.ts";

const handle = createSpecApprovalHandler({
  service: getSpecApprovalService(),
  actorResolver: async (request) => {
    const principal = await readRequestPrincipal(request, getOidcService());
    return principal ? { actorId: principal.actorId } : null;
  },
});

interface Context {
  params: Promise<{ goalId: string; specRevisionId: string }>;
}

export async function GET(request: Request, context: Context) {
  const { goalId, specRevisionId } = await context.params;
  return await handle(request, goalId, specRevisionId);
}

export async function POST(request: Request, context: Context) {
  const { goalId, specRevisionId } = await context.params;
  return await handle(request, goalId, specRevisionId);
}
