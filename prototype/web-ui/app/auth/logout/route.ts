import { handleOidcLogout } from "../oidc-http.ts";
import { getOidcService } from "../oidc-runtime.ts";
import { configuredWriteOrigins } from "../../security/request-security.ts";

export async function POST(request: Request): Promise<Response> {
  return handleOidcLogout(request, getOidcService(), configuredWriteOrigins());
}
