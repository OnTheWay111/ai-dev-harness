import { readRequestPrincipal } from "../../../../../auth/oidc-http.ts";
import { getOidcService } from "../../../../../auth/oidc-runtime.ts";
import { createClassificationHandler } from "../../../../../control-plane/http/classification-handler.ts";
import { getClassificationService } from "../../../../../control-plane/runtime/classification-runtime.ts";

const handle = createClassificationHandler({
  service: getClassificationService(),
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
