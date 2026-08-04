import { handleOidcLogin } from "../oidc-http.ts";
import { getOidcService } from "../oidc-runtime.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleOidcLogin(request, getOidcService());
}
