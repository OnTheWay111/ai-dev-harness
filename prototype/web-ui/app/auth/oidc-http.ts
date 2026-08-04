import type { OidcService } from "./oidc-service.ts";

export const TRANSACTION_COOKIE = "__Host-harness_oidc_tx";
export const SESSION_COOKIE = "__Host-harness_session";

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return secureCookie(name, "", 0);
}

function authenticationFailure(): Response {
  return Response.json({
    error: {
      code: "authentication_failed",
      message: "Authentication could not be completed",
      impact: "No session was created",
      preservedState: "Existing application data was not changed",
      nextAction: "Start a new sign-in attempt",
    },
  }, { status: 400 });
}

export async function handleOidcLogin(
  request: Request,
  service: OidcService,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  try {
    const returnTo = new URL(request.url).searchParams.get("returnTo");
    const started = await service.begin(returnTo);
    return new Response(null, {
      status: 302,
      headers: {
        location: started.authorizationUrl,
        "cache-control": "no-store",
        "set-cookie": secureCookie(
          TRANSACTION_COOKIE,
          started.transactionCookie,
          10 * 60,
        ),
      },
    });
  } catch {
    return authenticationFailure();
  }
}

export async function handleOidcCallback(
  request: Request,
  service: OidcService,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  try {
    const url = new URL(request.url);
    const completed = await service.complete({
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      transactionCookie: cookieValue(request, TRANSACTION_COOKIE),
    });
    const headers = new Headers({
      location: completed.returnTo,
      "cache-control": "no-store",
    });
    headers.append(
      "set-cookie",
      secureCookie(SESSION_COOKIE, completed.sessionCookie, 8 * 60 * 60),
    );
    headers.append("set-cookie", clearCookie(TRANSACTION_COOKIE));
    return new Response(null, { status: 303, headers });
  } catch {
    const response = authenticationFailure();
    response.headers.append("set-cookie", clearCookie(TRANSACTION_COOKIE));
    return response;
  }
}

export async function handleOidcLogout(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "cache-control": "no-store",
      "set-cookie": clearCookie(SESSION_COOKIE),
    },
  });
}

export async function handleOidcSession(
  request: Request,
  service: OidcService,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const principal = await service.readSession(cookieValue(request, SESSION_COOKIE));
  if (!principal) {
    return Response.json({
      error: {
        code: "unauthenticated",
        message: "A valid session is required",
      },
    }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  return Response.json({ data: principal }, {
    headers: { "cache-control": "private, no-store" },
  });
}
