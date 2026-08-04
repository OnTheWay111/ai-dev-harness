# PostgreSQL environments and Secret operations

This is the P1-01 source of truth for development, automated test, and
staging. The code representation lives in
`app/workbench/server/postgres-environment.ts`; its tests prevent the committed
environment templates and runtime mapping from drifting silently.

## Isolation and naming

Each environment uses a separate Neon project (PostgreSQL instance), not a
branch or database in a shared project. This keeps compute, storage, network
policy, backups, connection limits, and administrator access inside one
environment's blast radius.

| Deployment | Neon project / instance | Database | Workbench scope | Endpoint identity |
|---|---|---|---|---|
| development | `ai-dev-harness-development` | `ai_dev_harness_development` | `development` | unique `HARNESS_POSTGRES_ENDPOINT_ID` |
| test | `ai-dev-harness-test` | `ai_dev_harness_test` | `test` | unique `HARNESS_POSTGRES_ENDPOINT_ID` |
| staging | `ai-dev-harness-staging` | `ai_dev_harness_staging` | `staging` | unique `HARNESS_POSTGRES_ENDPOINT_ID` |

Do not reuse any project, database, login role, or Secret across rows. Staging
is pre-production and must never inherit development's fallback-to-demo
behavior.

After provisioning each project, set `HARNESS_POSTGRES_ENDPOINT_ID` to that
project's compute endpoint ID (the `ep-...` prefix from the Neon connection
hostname). This value is deployment configuration, not a Secret, but it must be
different for all three rows. Runtime configuration rejects a Secret URL whose
hostname does not carry the configured endpoint ID, including pooled hostnames.
Neon documents the endpoint-bearing hostname in its
[connection guidance](https://neon.com/docs/connect/connection-errors).

## Roles and grants

Every database has two `NOLOGIN` capability roles. Each capability has two
rotatable login roles, suffixed `_a` and `_b`. Only one login per capability is
referenced by the active Secret.

| Capability suffix | Required grants | Explicitly excluded |
|---|---|---|
| `_app` | database `CONNECT`; schema `USAGE`; current/future application tables `SELECT, INSERT, UPDATE, DELETE`; sequence `USAGE, SELECT` | schema/database `CREATE`, role administration, ownership |
| `_migrator` | database `CONNECT`; schema `USAGE, CREATE`; ownership/alter rights for migrated objects; grants/default privileges needed by `_app` | role administration, database creation, unrelated databases |

The complete role names are the database name plus `_app` or `_migrator`.
For example, development uses `ai_dev_harness_development_app` and
`ai_dev_harness_development_migrator`; login roles append `_a` or `_b`.

Provisioning is performed once by a Neon administrator. It must revoke
`CREATE` on schema `public` from `PUBLIC`, grant it only to the migrator
capability, grant app DML on migrated objects, and set migrator default
privileges so future tables and sequences remain usable by the app capability.
No password belongs in provisioning SQL, migration files, shell history, or
this repository. Create/reset the A/B login credentials through Neon, then
write their full connection URLs directly to the Secret manager.

The Neon administrator credential is break-glass only. It is never injected
into the app, migration job, CI test process, or a developer shell.

## Secret inventory and injection

| Deployment | Secret manager name | Injected name | Consumer |
|---|---|---|---|
| development | `AI_DEV_HARNESS_DEVELOPMENT_DATABASE_URL` | `DATABASE_URL` | development Web/API and seed/check job |
| development | `AI_DEV_HARNESS_DEVELOPMENT_MIGRATION_DATABASE_URL` | `MIGRATION_DATABASE_URL` | development migration/check job only |
| test | `AI_DEV_HARNESS_TEST_DATABASE_URL` | `DATABASE_URL` | test Web/API and integration test/check job |
| test | `AI_DEV_HARNESS_TEST_MIGRATION_DATABASE_URL` | `MIGRATION_DATABASE_URL` | test migration/check job only |
| staging | `AI_DEV_HARNESS_STAGING_DATABASE_URL` | `DATABASE_URL` | staging Web/API and smoke/check job |
| staging | `AI_DEV_HARNESS_STAGING_MIGRATION_DATABASE_URL` | `MIGRATION_DATABASE_URL` | staging migration/check job only |

The Secret manager name is an external logical name; the process receives only
the injected name. A Web/API deployment receives one app Secret and never a
migrator Secret. A migration job receives one migrator Secret and no app
Secret unless it separately runs a post-migration app check.

For local development, prefer a Secret-manager `exec` command that injects the
value into one child process. If that is unavailable for the Web/API process,
copy only the app template values into the root `.env.local` (already ignored),
restrict it to the current user, and delete it after use. Do not place a
migrator URL in `.env.local`; inject it into the migration child process. CI and
hosting must use their environment-scoped Secret injection features. Do not
pass a connection URL as a command argument, Docker build argument, client-side
variable, or checked-in deployment manifest.

`HARNESS_DEPLOYMENT_ENV`, `HARNESS_POSTGRES_ENDPOINT_ID`,
`WORKBENCH_DATA_SOURCE`, and `WORKBENCH_SCOPE_ID` are non-secret deployment
configuration. The application validates them as one mapping. When
`HARNESS_DEPLOYMENT_ENV` is set, `WORKBENCH_DATA_SOURCE` must be `postgres`, the
scope must match the environment, and the URL must name that environment's
configured Neon endpoint, database, and an allowed A/B app login. Missing or
crossed Secrets fail before a repository is created. Local use without
`HARNESS_DEPLOYMENT_ENV` retains the explicit prototype `auto`/`demo` behavior.

## Rotation

Rotate app and migrator credentials independently:

1. Identify the inactive A/B login for exactly one environment and capability.
2. Create or reset that login credential in Neon, retaining membership in the
   same capability role. Store the new URL as a new Secret-manager version.
3. Run the connectivity check against the pending version in an isolated job.
   Do not print the URL or raw driver error.
4. Promote the Secret version and restart only its consumers. Confirm the app
   check and normal readiness before continuing.
5. Revoke/reset the formerly active login, then retire the old Secret version
   according to the manager's audit/retention policy.

An endpoint replacement is infrastructure rotation, not an A/B credential
rotation. During an endpoint replacement, update
`HARNESS_POSTGRES_ENDPOINT_ID` and the pending Secret version together, validate
them in an isolated job, then promote the deployment configuration atomically.

Rotate every 90 days and immediately after suspected disclosure, access
removal, environment cloning, or a provider incident. Never rotate more than
one environment/capability pair at a time. Roll back by re-promoting the prior
Secret version before its login is revoked.

## Executable checks

Run these only through a process that already has the stated Secret and the
non-secret `HARNESS_POSTGRES_ENDPOINT_ID` injected:

```bash
HARNESS_DEPLOYMENT_ENV=development npm run db:check:postgres
HARNESS_DEPLOYMENT_ENV=development npm run db:check:postgres -- --access=migrator
```

The app check reads `DATABASE_URL`; the migrator check reads
`MIGRATION_DATABASE_URL`. Both verify the URL's environment/database/login
mapping, connect to PostgreSQL, compare the server-reported database and role,
check capability-role membership, and check schema privileges. App roles fail
if they have `CREATE`; migrator roles fail if they do not. Connection failures
return non-zero and suppress raw connection details.

Apply migrations only with the migrator Secret:

```bash
HARNESS_DEPLOYMENT_ENV=development npm run db:migrate:postgres
```

Run `npm run test:unit` to validate all environment mappings and failure-closed
behavior without a real credential. A real connectivity pass is required after
each instance is provisioned or rotated; a unit test is not a substitute for
that external check.
