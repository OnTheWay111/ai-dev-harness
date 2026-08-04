export const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
  ].join("; "),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
} as const;

export function withSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export function configuredWriteOrigins(
  environment: Record<string, string | undefined> = process.env,
): readonly string[] | undefined {
  const configured = environment.HARNESS_ALLOWED_ORIGINS?.trim();
  if (!configured) return undefined;
  const origins = configured.split(",").map((entry) => {
    const value = entry.trim();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("HARNESS_ALLOWED_ORIGINS contains an invalid URL");
    }
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (
      !value || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    ) {
      throw new Error(
        "HARNESS_ALLOWED_ORIGINS must contain HTTPS origins or HTTP loopback origins",
      );
    }
    return url.origin;
  });
  if (origins.length === 0) {
    throw new Error("HARNESS_ALLOWED_ORIGINS must contain at least one origin");
  }
  return [...new Set(origins)];
}

export type RequestSecurityErrorCode =
  | "csrf_rejected"
  | "invalid_content_type"
  | "payload_too_large"
  | "validation_failed"
  | "rate_limited";

export class RequestSecurityError extends Error {
  readonly code: RequestSecurityErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: RequestSecurityErrorCode,
    status: number,
    retryAfterSeconds?: number,
  ) {
    super("Request security validation failed");
    this.name = "RequestSecurityError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function assertSameOrigin(
  request: Request,
  allowedOrigins: readonly string[] = [new URL(request.url).origin],
): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw new RequestSecurityError("csrf_rejected", 403);
  }
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new RequestSecurityError("csrf_rejected", 403);
  }
}

export async function readJsonBody(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(
    request.headers.get("content-type") ?? "",
  )) {
    throw new RequestSecurityError("invalid_content_type", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength && /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maximumBytes
  ) {
    throw new RequestSecurityError("payload_too_large", 413);
  }
  if (!request.body) throw new RequestSecurityError("validation_failed", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestSecurityError("payload_too_large", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestSecurityError("validation_failed", 400);
  }
}

export interface RateLimitInput {
  actorId: string;
  organizationId: string;
  endpoint: string;
}

export interface RateLimiter {
  consume(input: RateLimitInput): void;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class MemoryFixedWindowRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(input: {
    limit: number;
    windowMs: number;
    now?: () => number;
  }) {
    this.limit = input.limit;
    this.windowMs = input.windowMs;
    this.now = input.now ?? Date.now;
  }

  consume(input: RateLimitInput): void {
    const now = this.now();
    const key = `${input.actorId}\0${input.organizationId}\0${input.endpoint}`;
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.limit) {
      throw new RequestSecurityError(
        "rate_limited",
        429,
        Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      );
    }
    bucket.count += 1;
  }
}

export const defaultWriteRateLimiter = new MemoryFixedWindowRateLimiter({
  limit: 30,
  windowMs: 60_000,
});
