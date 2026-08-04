import { handleOidcSession } from "../../../auth/oidc-http.ts";
import { getOidcService } from "../../../auth/oidc-runtime.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleOidcSession(request, getOidcService());
}
