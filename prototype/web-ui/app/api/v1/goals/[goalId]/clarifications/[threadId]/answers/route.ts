import { readRequestPrincipal } from "../../../../../../../auth/oidc-http.ts";
import { getOidcService } from "../../../../../../../auth/oidc-runtime.ts";
import { createClarificationHistoryHandler } from "../../../../../../../control-plane/http/clarification-history-handler.ts";
import { getClarificationHistoryService } from "../../../../../../../control-plane/runtime/clarification-history-runtime.ts";

const handle = createClarificationHistoryHandler({
  service: getClarificationHistoryService(),
  actorResolver: async (request) => {
    const principal = await readRequestPrincipal(request, getOidcService());
    return principal ? { actorId: principal.actorId } : null;
  },
});

interface Context { params: Promise<{ goalId: string; threadId: string }> }

export async function POST(request: Request, context: Context) {
  const { goalId, threadId } = await context.params;
  return await handle(request, goalId, threadId);
}
