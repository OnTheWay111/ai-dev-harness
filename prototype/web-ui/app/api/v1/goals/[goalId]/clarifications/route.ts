import { readRequestPrincipal } from "../../../../../auth/oidc-http.ts";
import { getOidcService } from "../../../../../auth/oidc-runtime.ts";
import { createClarificationHistoryHandler } from "../../../../../control-plane/http/clarification-history-handler.ts";
import { getClarificationHistoryService } from "../../../../../control-plane/runtime/clarification-history-runtime.ts";

const handle = createClarificationHistoryHandler({
  service: getClarificationHistoryService(),
  actorResolver: async (request) => {
    const principal = await readRequestPrincipal(request, getOidcService());
    return principal ? { actorId: principal.actorId } : null;
  },
});

interface Context { params: Promise<{ goalId: string }> }

export async function GET(request: Request, context: Context) {
  return await handle(request, (await context.params).goalId);
}

export async function POST(request: Request, context: Context) {
  return await handle(request, (await context.params).goalId);
}
