# OIDC/SSO and session contract

P3-01 uses a provider-neutral OpenID Connect Authorization Code flow with PKCE.
The application owns `/auth/login`, `/auth/callback`, `/auth/logout`, and
`/api/v1/session`; the optional dispatch-owned ChatGPT identity headers remain
separate and are not trusted as the Production V1 control-plane session.

## Server-side configuration

The deployment Secret manager injects these values only into the Web/API
runtime:

| Variable | Secret | Purpose |
|---|---:|---|
| `OIDC_ISSUER` | no | Exact issuer used for discovery and claim validation |
| `OIDC_CLIENT_ID` | no | Environment-specific OIDC client registration |
| `OIDC_CLIENT_SECRET` | yes | Confidential client credential; optional only for providers that permit it |
| `OIDC_REDIRECT_URI` | no | Exact HTTPS callback registered with the provider |
| `OIDC_COOKIE_SECRET` | yes | 32 random bytes encoded as base64url for AES-256-GCM cookie envelopes |
| `OIDC_ALLOWED_RETURN_TO_PATHS` | no | Comma-separated same-origin path allowlist |
| `OIDC_SESSION_TTL_SECONDS` | no | Short session lifetime, at most eight hours |
| `OIDC_TRANSACTION_TTL_SECONDS` | no | Login transaction lifetime, at most 15 minutes |

Do not use `NEXT_PUBLIC_`, build arguments, command arguments, logs, Git, or
browser storage for either Secret. Development, test, and staging use separate
client registrations and cookie keys. Rotate the client Secret in the IdP and
Secret manager using an overlap window when the provider supports two active
credentials. Rotating the cookie key is intentionally fail-closed and expires
all prior application sessions; schedule it as a sign-in maintenance event.

## Security properties

1. Login discovers an exact issuer, generates random `state`, `nonce`, and a
   PKCE verifier, then stores them in a ten-minute AES-GCM transaction Cookie.
2. Callback exchanges the one-time code over HTTPS and validates the ID Token's
   RS256 signature, `kid`, issuer, audience, nonce, expiry, and issued-at time.
3. OIDC access, refresh, and ID Tokens are discarded after validation. The
   browser receives only an encrypted application session containing the
   minimum identity claims and an opaque stable actor ID.
4. Both Cookies use the `__Host-` prefix, `Path=/`, `HttpOnly`, `Secure`, and
   `SameSite=Lax`. Session responses use `no-store`.
5. Logout is POST-only and expires the application Cookie. P3-04 adds the
   common CSRF middleware to this and every other write route.
6. `returnTo` accepts only configured same-origin path families and rejects
   external, scheme-relative, encoded slash/backslash, and recursive auth paths.

The local fake IdP contract test performs real RSA signing and PKCE verification
and covers success, expiry, signature failure, authorization-code replay, and
illegal `returnTo`. No real credential is required or recorded.
