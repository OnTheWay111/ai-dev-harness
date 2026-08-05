export type OidcAuthenticationErrorCode =
  | "configuration"
  | "expired"
  | "invalid_request"
  | "invalid_state"
  | "invalid_token"
  | "token_exchange_failed";

export class OidcAuthenticationError extends Error {
  readonly code: OidcAuthenticationErrorCode;

  constructor(code: OidcAuthenticationErrorCode) {
    super("OIDC authentication failed");
    this.name = "OidcAuthenticationError";
    this.code = code;
  }
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  cookieSecret: string;
  allowedReturnToPaths: readonly string[];
  sessionTtlSeconds: number;
  transactionTtlSeconds: number;
}

export interface AuthenticatedPrincipal {
  issuer: string;
  subject: string;
  actorId: string;
  email: string | null;
  displayName: string;
  expiresAt: string;
}

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
}

interface TransactionPayload {
  kind: "oidc_transaction";
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

interface SessionPayload {
  kind: "oidc_session";
  issuer: string;
  subject: string;
  actorId: string;
  email: string | null;
  displayName: string;
  expiresAt: number;
  sessionId: string;
}

interface JwtPayload {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  azp?: unknown;
  nonce?: unknown;
  exp?: unknown;
  iat?: unknown;
  email?: unknown;
  name?: unknown;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TRANSACTION_AUDIENCE = "ai-dev-harness:oidc-transaction:v1";
const SESSION_AUDIENCE = "ai-dev-harness:session:v1";

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function randomValue(byteLength = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function stableActorId(issuer: string, subject: string): Promise<string> {
  return `oidc_${[...await sha256(`${issuer}\0${subject}`)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function cookieKey(secret: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = decodeBase64Url(secret);
  } catch {
    throw new OidcAuthenticationError("configuration");
  }
  if (raw.byteLength !== 32) {
    throw new OidcAuthenticationError("configuration");
  }
  return crypto.subtle.importKey("raw", asArrayBuffer(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function seal(
  payload: Readonly<Record<string, unknown>>,
  secret: string,
  audience: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(audience) },
    await cookieKey(secret),
    encoder.encode(JSON.stringify(payload)),
  );
  return `v1.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

async function unseal(
  value: string,
  secret: string,
  audience: string,
): Promise<unknown> {
  try {
    const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
    if (version !== "v1" || !encodedIv || !encodedCiphertext || extra) {
      throw new Error("invalid envelope");
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(decodeBase64Url(encodedIv)),
        additionalData: encoder.encode(audience),
      },
      await cookieKey(secret),
      asArrayBuffer(decodeBase64Url(encodedCiphertext)),
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch (error) {
    if (
      error instanceof OidcAuthenticationError &&
      error.code === "configuration"
    ) {
      throw error;
    }
    throw new OidcAuthenticationError("invalid_request");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeEndpoint(value: unknown): string {
  if (typeof value !== "string") {
    throw new OidcAuthenticationError("configuration");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcAuthenticationError("configuration");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new OidcAuthenticationError("configuration");
  }
  return url.toString();
}

function normalizeIssuer(value: string): string {
  return safeEndpoint(value).replace(/\/$/, "");
}

export function oidcLoginUrl(
  returnTo: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const safeReturnTo = /^\/[A-Za-z0-9/_-]*$/.test(returnTo) ? returnTo : "/";
  const relative = `/auth/login?returnTo=${safeReturnTo}`;
  const redirectUri = environment.OIDC_REDIRECT_URI?.trim();
  if (!redirectUri) return relative;
  try {
    return `${new URL(safeEndpoint(redirectUri)).origin}${relative}`;
  } catch {
    return relative;
  }
}

export function normalizeReturnTo(
  value: string | null | undefined,
  allowedPaths: readonly string[],
): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (/\\|%2f|%5c/i.test(value)) return "/";
  let url: URL;
  try {
    url = new URL(value, "https://harness.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "https://harness.invalid") return "/";
  if (
    url.pathname === "/auth/login" ||
    url.pathname === "/auth/callback" ||
    url.pathname === "/auth/logout"
  ) {
    return "/";
  }
  const allowed = allowedPaths.some((path) =>
    path === "/"
      ? url.pathname === "/"
      : url.pathname === path || url.pathname.startsWith(`${path}/`)
  );
  return allowed ? `${url.pathname}${url.search}${url.hash}` : "/";
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new OidcAuthenticationError("configuration");
  const parsed = Number(value);
  if (parsed < 60 || parsed > maximum) {
    throw new OidcAuthenticationError("configuration");
  }
  return parsed;
}

export function loadOidcConfig(
  environment: Readonly<Record<string, string | undefined>>,
): OidcConfig {
  const required = (name: string): string => {
    const value = environment[name]?.trim();
    if (!value) throw new OidcAuthenticationError("configuration");
    return value;
  };
  const issuer = normalizeIssuer(required("OIDC_ISSUER"));
  const redirectUri = safeEndpoint(required("OIDC_REDIRECT_URI"));
  const allowedReturnToPaths = (environment.OIDC_ALLOWED_RETURN_TO_PATHS ?? "/")
    .split(",")
    .map((path) => path.trim())
    .filter((path) => /^\/[A-Za-z0-9/_-]*$/.test(path));
  if (allowedReturnToPaths.length === 0) {
    throw new OidcAuthenticationError("configuration");
  }
  return {
    issuer,
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: environment.OIDC_CLIENT_SECRET?.trim() || undefined,
    redirectUri,
    cookieSecret: required("OIDC_COOKIE_SECRET"),
    allowedReturnToPaths,
    sessionTtlSeconds: parsePositiveInteger(
      environment.OIDC_SESSION_TTL_SECONDS,
      8 * 60 * 60,
      8 * 60 * 60,
    ),
    transactionTtlSeconds: parsePositiveInteger(
      environment.OIDC_TRANSACTION_TTL_SECONDS,
      10 * 60,
      15 * 60,
    ),
  };
}

export async function createCookieSecret(): Promise<string> {
  return randomValue(32);
}

function transactionPayload(value: unknown): TransactionPayload {
  if (
    !isRecord(value) ||
    value.kind !== "oidc_transaction" ||
    typeof value.state !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.verifier !== "string" ||
    typeof value.returnTo !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    throw new OidcAuthenticationError("invalid_request");
  }
  return value as unknown as TransactionPayload;
}

function sessionPayload(value: unknown): SessionPayload {
  if (
    !isRecord(value) ||
    value.kind !== "oidc_session" ||
    typeof value.issuer !== "string" ||
    typeof value.subject !== "string" ||
    typeof value.actorId !== "string" ||
    !(typeof value.email === "string" || value.email === null) ||
    typeof value.displayName !== "string" ||
    typeof value.expiresAt !== "number" ||
    typeof value.sessionId !== "string"
  ) {
    throw new OidcAuthenticationError("invalid_request");
  }
  return value as unknown as SessionPayload;
}

function decodeJwtPart(value: string): unknown {
  try {
    return JSON.parse(decoder.decode(decodeBase64Url(value)));
  } catch {
    throw new OidcAuthenticationError("invalid_token");
  }
}

async function verifyIdToken(input: {
  token: string;
  discovery: DiscoveryDocument;
  config: OidcConfig;
  expectedNonce: string;
  fetch: typeof fetch;
  nowSeconds: number;
}): Promise<JwtPayload> {
  const parts = input.token.split(".");
  if (parts.length !== 3) throw new OidcAuthenticationError("invalid_token");
  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  if (
    !isRecord(header) ||
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    !isRecord(payload)
  ) {
    throw new OidcAuthenticationError("invalid_token");
  }
  const jwksResponse = await input.fetch(input.discovery.jwks_uri, {
    headers: { accept: "application/json" },
  });
  if (!jwksResponse.ok) throw new OidcAuthenticationError("invalid_token");
  const jwks: unknown = await jwksResponse.json();
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) {
    throw new OidcAuthenticationError("invalid_token");
  }
  const jwk = jwks.keys.find((key) =>
    isRecord(key) &&
    key.kid === header.kid &&
    key.kty === "RSA" &&
    (key.alg === undefined || key.alg === "RS256") &&
    (key.use === undefined || key.use === "sig")
  );
  if (!isRecord(jwk)) throw new OidcAuthenticationError("invalid_token");
  let signatureValid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      asArrayBuffer(decodeBase64Url(parts[2])),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    throw new OidcAuthenticationError("invalid_token");
  }
  const claims = payload as JwtPayload;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !signatureValid ||
    claims.iss !== input.config.issuer ||
    typeof claims.sub !== "string" ||
    claims.sub.length < 1 ||
    !audience.includes(input.config.clientId) ||
    (audience.length > 1 && claims.azp !== input.config.clientId) ||
    claims.nonce !== input.expectedNonce ||
    typeof claims.exp !== "number" ||
    claims.exp <= input.nowSeconds ||
    typeof claims.iat !== "number" ||
    claims.iat > input.nowSeconds + 60
  ) {
    throw new OidcAuthenticationError("invalid_token");
  }
  return claims;
}

export class OidcService {
  private readonly config: OidcConfig;
  private readonly fetch: typeof fetch;
  private readonly clock: () => Date;
  private discovery?: Promise<DiscoveryDocument>;

  constructor(input: {
    config: OidcConfig;
    fetch?: typeof fetch;
    clock?: () => Date;
  }) {
    this.config = input.config;
    this.fetch = input.fetch ?? fetch;
    this.clock = input.clock ?? (() => new Date());
  }

  private async discover(): Promise<DiscoveryDocument> {
    this.discovery ??= (async () => {
      const response = await this.fetch(
        `${this.config.issuer}/.well-known/openid-configuration`,
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) throw new OidcAuthenticationError("configuration");
      const value: unknown = await response.json();
      if (!isRecord(value) || value.issuer !== this.config.issuer) {
        throw new OidcAuthenticationError("configuration");
      }
      if (
        Array.isArray(value.id_token_signing_alg_values_supported) &&
        !value.id_token_signing_alg_values_supported.includes("RS256")
      ) {
        throw new OidcAuthenticationError("configuration");
      }
      return {
        issuer: this.config.issuer,
        authorization_endpoint: safeEndpoint(value.authorization_endpoint),
        token_endpoint: safeEndpoint(value.token_endpoint),
        jwks_uri: safeEndpoint(value.jwks_uri),
      };
    })();
    return this.discovery;
  }

  async begin(returnToValue?: string | null): Promise<{
    authorizationUrl: string;
    transactionCookie: string;
    returnTo: string;
  }> {
    const discovery = await this.discover();
    const state = randomValue();
    const nonce = randomValue();
    const verifier = randomValue();
    const returnTo = normalizeReturnTo(
      returnToValue,
      this.config.allowedReturnToPaths,
    );
    const challenge = encodeBase64Url(await sha256(verifier));
    const authorization = new URL(discovery.authorization_endpoint);
    authorization.searchParams.set("client_id", this.config.clientId);
    authorization.searchParams.set("redirect_uri", this.config.redirectUri);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", "openid profile email");
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("nonce", nonce);
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    const expiresAt = this.clock().getTime() +
      this.config.transactionTtlSeconds * 1000;
    return {
      authorizationUrl: authorization.toString(),
      transactionCookie: await seal({
        kind: "oidc_transaction",
        state,
        nonce,
        verifier,
        returnTo,
        expiresAt,
      }, this.config.cookieSecret, TRANSACTION_AUDIENCE),
      returnTo,
    };
  }

  async complete(input: {
    code: string | null;
    state: string | null;
    transactionCookie: string | null;
  }): Promise<{ returnTo: string; sessionCookie: string }> {
    if (!input.code || !input.state || !input.transactionCookie) {
      throw new OidcAuthenticationError("invalid_request");
    }
    const transaction = transactionPayload(await unseal(
      input.transactionCookie,
      this.config.cookieSecret,
      TRANSACTION_AUDIENCE,
    ));
    if (transaction.expiresAt <= this.clock().getTime()) {
      throw new OidcAuthenticationError("expired");
    }
    if (transaction.state !== input.state) {
      throw new OidcAuthenticationError("invalid_state");
    }
    const discovery = await this.discover();
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code_verifier: transaction.verifier,
    });
    if (this.config.clientSecret) {
      tokenBody.set("client_secret", this.config.clientSecret);
    }
    const tokenResponse = await this.fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });
    if (!tokenResponse.ok) {
      throw new OidcAuthenticationError("token_exchange_failed");
    }
    const tokenValue: unknown = await tokenResponse.json();
    if (!isRecord(tokenValue) || typeof tokenValue.id_token !== "string") {
      throw new OidcAuthenticationError("token_exchange_failed");
    }
    const now = this.clock();
    const claims = await verifyIdToken({
      token: tokenValue.id_token,
      discovery,
      config: this.config,
      expectedNonce: transaction.nonce,
      fetch: this.fetch,
      nowSeconds: Math.floor(now.getTime() / 1000),
    });
    const subject = claims.sub as string;
    const expiresAt = now.getTime() + this.config.sessionTtlSeconds * 1000;
    const email = typeof claims.email === "string" ? claims.email : null;
    const displayName = typeof claims.name === "string"
      ? claims.name
      : email ?? "Authenticated user";
    const session: SessionPayload = {
      kind: "oidc_session",
      issuer: this.config.issuer,
      subject,
      actorId: await stableActorId(this.config.issuer, subject),
      email,
      displayName,
      expiresAt,
      sessionId: randomValue(),
    };
    return {
      returnTo: transaction.returnTo,
      sessionCookie: await seal(
        session as unknown as Record<string, unknown>,
        this.config.cookieSecret,
        SESSION_AUDIENCE,
      ),
    };
  }

  async readSession(cookie: string | null | undefined): Promise<
    AuthenticatedPrincipal | null
  > {
    if (!cookie) return null;
    let session: SessionPayload;
    try {
      session = sessionPayload(await unseal(
        cookie,
        this.config.cookieSecret,
        SESSION_AUDIENCE,
      ));
    } catch {
      return null;
    }
    if (
      session.issuer !== this.config.issuer ||
      session.expiresAt <= this.clock().getTime()
    ) {
      return null;
    }
    return {
      issuer: session.issuer,
      subject: session.subject,
      actorId: session.actorId,
      email: session.email,
      displayName: session.displayName,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }
}
