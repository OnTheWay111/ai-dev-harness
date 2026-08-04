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

## Useful Commands

- `npm run dev`: start local development
- `npm run typecheck`: type-check the Web UI surface
- `npm run build`: verify the vinext build output
- `npm test`: build and run SSR, HTTP API, client adapter, and selector tests
- `npm run test:postgres:integration`: create, migrate, test, and destroy a
  temporary real PostgreSQL database
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
`WORKBENCH_SCOPE_ID` selects the tenant/project projection and defaults to
`default` only for unmanaged local use.

### PostgreSQL setup

Create a Neon-compatible PostgreSQL database. Copy `.env.example` to an ignored
`.env.local` for vinext. For database commands, use a Secret-manager command
that injects only the value needed by each child process:

```bash
# MIGRATION_DATABASE_URL is injected only for this command.
npm run db:migrate:postgres

# DATABASE_URL is injected only for these commands.
npm run db:seed:postgres
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

The seed command is only a bootstrap utility. In the real pipeline, the
scheduler/aggregator owns `WorkbenchSnapshot` generation and calls
`NeonWorkbenchProjectionWriter.replaceProjection()` once per revision and
scope. Projection writes for one scope must be serialized; the writer replaces
the snapshot and its ordered task rows in one database batch.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
