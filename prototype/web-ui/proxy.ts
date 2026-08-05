import { NextResponse } from "next/server";

import { SECURITY_HEADERS } from "./app/security/request-security.ts";
import { propagateRequestHeaders } from "./app/observability/context.ts";

export function proxy(request: Request): NextResponse {
  const propagated = propagateRequestHeaders(request.headers);
  const response = NextResponse.next({
    request: { headers: propagated.headers },
  });
  response.headers.set("x-request-id", propagated.requestId);
  response.headers.set(
    "traceparent",
    propagated.headers.get("traceparent") as string,
  );
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = { matcher: "/:path*" };
