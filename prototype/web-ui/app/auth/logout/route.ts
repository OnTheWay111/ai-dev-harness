import { handleOidcLogout } from "../oidc-http.ts";

export async function POST(request: Request): Promise<Response> {
  return handleOidcLogout(request);
}
