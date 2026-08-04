# AI Dev Harness Web UI

A vinext/Cloudflare Worker workbench prototype. The application can use its
server-only demo projection for local development or a PostgreSQL workbench read
model through Neon and Drizzle.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `app/page.tsx` only mounts the workbench application
- `app/workbench/contracts.ts` defines the V1 workbench DTO and command contract
- `app/workbench/components/` contains the shell and independently testable views
- `app/workbench/selectors.ts` owns task filtering, counts, and display formatting
- `app/workbench/workbench-api.ts` is the browser HTTP adapter with ETag caching
- `app/workbench/server/` contains the demo/PostgreSQL repositories and projection writer
- `app/api/v1/workbench/route.ts` serves filtering, pagination, ETag, and structured errors
- `db/postgres-schema.ts` defines the PostgreSQL workbench read model
- `drizzle-postgres/` contains committed PostgreSQL migrations
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Production OIDC/SSO

The control-plane session uses provider-neutral OIDC Authorization Code + PKCE,
independently of the optional hosting integration above. Configuration,
server-only Secret handling, routes, Cookie policy, rotation, and fake IdP
verification are documented in
[`../../docs/oidc-sso.md`](../../docs/oidc-sso.md).

The server-side role matrix, scope inheritance, delegation boundary, default
deny behavior, and role-change Audit transaction are documented in
[`../../docs/server-rbac.md`](../../docs/server-rbac.md).

## Useful Commands

- `npm run dev`: start local development
- `npm run typecheck`: type-check the Web UI surface
- `npm run build`: verify the vinext build output
- `npm test`: build and run SSR, HTTP API, client adapter, and selector tests
- `npm run test:spec-review`: run the focused P5 revision, approval, recovery,
  accessibility-contract, and compiler-gate tests
- `npm run test:browser:spec-review`: run the HTTPS Chromium review path (run
  `npx playwright install chromium` once on a new development machine)
- `npm run test:postgres:integration`: create, migrate, test, and destroy a
  temporary real PostgreSQL database
- `npm run ci:p1`: run the local equivalent of the P1 PostgreSQL CI gate
- `npm run db:generate`: generate Drizzle migrations after schema changes
- `npm run db:generate:postgres`: generate workbench PostgreSQL migrations
- `npm run db:migrate:postgres`: atomically apply committed PostgreSQL
  migrations using `MIGRATION_DATABASE_URL`
- `npm run db:seed:postgres`: publish the demo snapshot to the configured scope
- `npm run db:check:postgres`: validate environment mapping, connection identity,
  and least-privilege grants without printing connection details
- `npm run db:check:migration:postgres`: validate the development migration
  ledger, live schema, grants, and committed receipt
- `npm run db:verify:development:postgres`: publish an isolated development
  scope, verify PostgreSQL SSR/API behavior, and clean it up

## Workbench API

The initial page is server-rendered from the `WorkbenchReadRepository`. After
hydration, the browser refreshes the same snapshot through:

```text
GET /api/v1/workbench
```

Supported query parameters are `goalId`, `filter`, `cursor`, and `limit`. The
response implements `workbench.v1`, emits an ETag, identifies the active source
through `x-workbench-source`, and returns the shared error envelope for invalid
requests.

`WORKBENCH_DATA_SOURCE` controls the server repository:

- `auto` (default) selects PostgreSQL when `DATABASE_URL` exists and otherwise
  keeps the local demo projection.
- `demo` always uses the server-only demo projection.
- `postgres` requires `DATABASE_URL` and fails closed when it is absent.

Managed development, test, and staging deployments set
`HARNESS_DEPLOYMENT_ENV` plus the non-secret `HARNESS_POSTGRES_ENDPOINT_ID`, and
must use explicit `postgres` mode. Their Neon endpoint, database, role, and
scope mapping is validated before repository creation, so a missing or
cross-environment Secret cannot silently expose demo data.
`WORKBENCH_SCOPE_ID` selects the deployment projection namespace and defaults
to `default` only for unmanaged local use. Authorization comes only from the
server-derived Organization/Project visibility scope, never from this value or
an HTTP query parameter.

### PostgreSQL setup

Create a Neon-compatible PostgreSQL database. Copy `.env.example` to an ignored
`.env.local` for vinext. For database commands, use a Secret-manager command
that injects only the value needed by each child process:

```bash
# MIGRATION_DATABASE_URL is injected only for this command.
npm run db:migrate:postgres

# DATABASE_URL is injected only for these commands.
WORKBENCH_ORGANIZATION_ID=<uuid> WORKBENCH_PROJECT_ID=<uuid> npm run db:seed:postgres
WORKBENCH_DATA_SOURCE=postgres WORKBENCH_SCOPE_ID=default npm run dev
```

The two injected URLs must use separate app and migrator roles. Prefer injecting
them with a Secret manager instead of entering them in shell history. Managed
environment names, role grants, Secret names, templates, connectivity checks,
and rotation steps are defined in
[`docs/postgres-environments.md`](docs/postgres-environments.md). Never expose
either value through a `NEXT_PUBLIC_` variable, build argument, log, or browser
bundle.

The one-time migration ledger setup, atomic and idempotent runner behavior,
receipt contract, and verification command are defined in
[`docs/postgres-migrations.md`](docs/postgres-migrations.md).
The reproducible real-database SSR/API evidence is recorded in
[`docs/p1-03-development-postgres-verification.md`](docs/p1-03-development-postgres-verification.md).
Temporary local/CI PostgreSQL lifecycle and transaction coverage are documented
in [`docs/postgres-integration-tests.md`](docs/postgres-integration-tests.md).
Production/pre-production fail-closed rules and the `/health/ready` contract are
documented in [`docs/readiness.md`](docs/readiness.md).
Migration drift, isolated CI PostgreSQL, and client Secret scanning are
documented in [`docs/continuous-integration.md`](docs/continuous-integration.md).
Authoritative control-plane entities are defined in
[`../../docs/control-plane-data-dictionary.md`](../../docs/control-plane-data-dictionary.md),
separately from the replaceable workbench projection.
Goal, SpecRevision, Issue, and Run lifecycle rules are listed in
[`../../docs/control-plane-state-machines.md`](../../docs/control-plane-state-machines.md).
The versioned Goal Contract fields, CRUD API, authorization transaction, and
browser draft-recovery boundary are documented in
[`../../docs/goal-workspace.md`](../../docs/goal-workspace.md).
The isolated, read-only Codex Planner subprocess contract and controlled smoke
test are documented in
[`../../docs/codex-planner.md`](../../docs/codex-planner.md).
The versioned clarification JSON Schema, strict server validation, fixtures,
and diagnostic contract are documented in
[`../../docs/planner-output-schema.md`](../../docs/planner-output-schema.md).
The append-only clarification rounds, question/answer revisions, human
decisions, API/UI timeline, and concurrency rules are documented in
[`../../docs/clarification-history.md`](../../docs/clarification-history.md).
The strict Proposal/PRD bundle, immutable content-addressed Artifact Store,
SpecRevision generation API, and controlled Planner smoke test are documented
in [`../../docs/spec-artifacts.md`](../../docs/spec-artifacts.md).
Helpful exceptions, scope-change requests, immutable approval history, and the
default removal of Speculative elements, revision comparison, stale-conflict
recovery, and the P5→P6 compilation gate are documented in
[`../../docs/spec-approvals.md`](../../docs/spec-approvals.md).
The versioned deterministic S/M/L/XL and risk policy, factor explanations,
required Artifacts, approvers, and persistence contract are documented in
[`../../docs/deterministic-classification.md`](../../docs/deterministic-classification.md).
The Goal write-module interface, Repository seam, adapters, and HTTP mapping are
documented in
[`../../docs/control-plane-write-architecture.md`](../../docs/control-plane-write-architecture.md).
OIDC actor visibility, SQL-scoped task/summary reads, and cache isolation are
documented in
[`../../docs/visibility-scoped-reads.md`](../../docs/visibility-scoped-reads.md).
CSRF/同源校验、严格请求 Schema、大小上限、限流、安全响应头和稳定错误响应记录在
[`../../docs/web-security-baseline.md`](../../docs/web-security-baseline.md)。
真实 PostgreSQL 的匿名、越权、跨项目数量、重复审批、跨用户幂等和 Audit 防篡改覆盖见
[`../../docs/security-regression-matrix.md`](../../docs/security-regression-matrix.md)。

The seed command is only a bootstrap utility. In the real pipeline, the
scheduler/aggregator owns `WorkbenchSnapshot` generation and calls
`NeonWorkbenchProjectionWriter.replaceProjection()` once per revision and
Organization/Project scope. Projection writes for one composite scope must be
serialized; the writer replaces that Project snapshot and its ordered task rows
in one database batch.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
