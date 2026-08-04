import { withSecurityHeaders } from "../../security/request-security.ts";

export function GET() {
  return withSecurityHeaders(Response.json({ status: "live" }, {
    headers: { "cache-control": "no-store" },
  }));
}
