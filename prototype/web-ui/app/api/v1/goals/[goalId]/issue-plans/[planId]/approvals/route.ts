import { readRequestPrincipal } from "../../../../../../../auth/oidc-http.ts";
import { getOidcService } from "../../../../../../../auth/oidc-runtime.ts";
import { createIssuePlanHandlers } from
  "../../../../../../../control-plane/http/issue-plan-handler.ts";
import {
  getIssuePlanGenerationService,
  getIssuePlanService,
  getQueueProjectionService,
} from "../../../../../../../control-plane/runtime/issue-plan-runtime.ts";
import { configuredWriteOrigins } from
  "../../../../../../../security/request-security.ts";

const handlers = createIssuePlanHandlers({
  plans: getIssuePlanService(),
  generation: getIssuePlanGenerationService(),
  projection: getQueueProjectionService(),
  allowedOrigins: configuredWriteOrigins(),
  actorResolver: async (request) => {
    const principal = await readRequestPrincipal(request, getOidcService());
    return principal ? { actorId: principal.actorId } : null;
  },
});

interface Context { params: Promise<{ goalId: string; planId: string }> }

export async function POST(request: Request, context: Context) {
  const { goalId, planId } = await context.params;
  return await handlers.approval(request, goalId, planId);
}
