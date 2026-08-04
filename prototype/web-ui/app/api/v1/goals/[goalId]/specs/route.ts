import { readRequestPrincipal } from "../../../../../auth/oidc-http.ts";
import { getOidcService } from "../../../../../auth/oidc-runtime.ts";
import { createSpecGenerationHandler } from
  "../../../../../control-plane/http/spec-generation-handler.ts";
import { getSpecGenerationService } from
  "../../../../../control-plane/runtime/spec-generation-runtime.ts";
import { configuredWriteOrigins } from
  "../../../../../security/request-security.ts";

const handle = createSpecGenerationHandler({
  service: getSpecGenerationService(),
  allowedOrigins: configuredWriteOrigins(),
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
