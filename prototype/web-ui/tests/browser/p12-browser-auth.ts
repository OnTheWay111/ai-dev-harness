import { OidcService } from "../../app/auth/oidc-service";

export const p12BaseURL = "https://localhost:4175";
export const p12OrganizationId = "00000000-0000-4000-8000-000000000001";
export const p12ProjectId = "00000000-0000-4000-8000-000000000002";
export const p12ReleaseGoalId = "00000000-0000-4000-8000-0000000000a1";

const issuer = "https://p12-issuer.example.invalid";
const clientId = "p12-browser-client";
const cookieSecret = Buffer.alloc(32, 12).toString("base64url");

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function p12SessionCookie(
  subject = "p12-approver",
): Promise<string> {
  const keys = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  Object.assign(publicJwk, { kid: "p12-e2e", alg: "RS256", use: "sig" });
  let nonce = "";
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.endsWith("/jwks")) return Response.json({ keys: [publicJwk] });
    if (url.endsWith("/token")) {
      const header = encoded({ alg: "RS256", kid: "p12-e2e", typ: "JWT" });
      const payload = encoded({
        iss: issuer,
        sub: subject,
        aud: clientId,
        nonce,
        iat: nowSeconds,
        exp: nowSeconds + 3_600,
        email: `${subject}@example.invalid`,
        name: `P12 ${subject}`,
      });
      const signingInput = `${header}.${payload}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return Response.json({
        id_token: `${signingInput}.${Buffer.from(signature).toString("base64url")}`,
      });
    }
    return new Response(null, { status: 404 });
  };
  const oidc = new OidcService({
    config: {
      issuer,
      clientId,
      redirectUri: `${p12BaseURL}/auth/callback`,
      cookieSecret,
      allowedReturnToPaths: ["/", "/releases"],
      sessionTtlSeconds: 3_600,
      transactionTtlSeconds: 600,
    },
    fetch: fakeFetch as typeof fetch,
  });
  const started = await oidc.begin("/");
  const authorization = new URL(started.authorizationUrl);
  nonce = authorization.searchParams.get("nonce") ?? "";
  return (await oidc.complete({
    code: "p12-code",
    state: authorization.searchParams.get("state"),
    transactionCookie: started.transactionCookie,
  })).sessionCookie;
}

export async function installP12Session(
  context: import("@playwright/test").BrowserContext,
  subject = "p12-approver",
): Promise<void> {
  await context.addCookies([{
    name: "__Host-harness_session",
    value: await p12SessionCookie(subject),
    url: p12BaseURL,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);
}
