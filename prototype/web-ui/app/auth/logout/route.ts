import { handleOidcLogout } from "../oidc-http.ts";
import { getOidcService } from "../oidc-runtime.ts";

export async function POST(request: Request): Promise<Response> {
  return handleOidcLogout(request, getOidcService());
}
