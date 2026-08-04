import { NextResponse } from "next/server";

import { SECURITY_HEADERS } from "./app/security/request-security.ts";

export function proxy(): NextResponse {
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = { matcher: "/:path*" };

