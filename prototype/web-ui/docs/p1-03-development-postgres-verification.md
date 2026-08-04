# P1-03 development PostgreSQL verification

P1-03 was executed on 2026-08-04 against the isolated Neon development
database defined by P1-01 and migrated by P1-02. The verification used the
least-privilege development `_app_a` login. No administrator URL, connection
string, password, hostname, or raw driver error was written to this evidence.

## Reproduce

Build and run the verification from `prototype/web-ui` through a Secret manager
that injects `AI_DEV_HARNESS_DEVELOPMENT_DATABASE_URL` as `DATABASE_URL` only
for the child process:

```bash
HARNESS_DEPLOYMENT_ENV=development \
HARNESS_POSTGRES_ENDPOINT_ID=<development-endpoint-id> \
<secret-manager-exec> -- \
  npm run db:verify:development:postgres
```

The command creates a random `p1_03_*` scope, publishes revision `103`, starts
the production build with `WORKBENCH_DATA_SOURCE=postgres`, exercises SSR and
the HTTP API through the built Worker, and removes the scope in a `finally`
block. Configuration and connection failures return non-zero and suppress
connection details.

## Observed result

| Check | Result |
|---|---|
| SSR rendered the isolated projection | passed; revision marker `103` |
| API revision matched SSR | passed; `103` |
| `x-workbench-source` | `postgres` |
| summary counts | all 7, attention 4, running 1, review 1, blocked 2, waiting 3 |
| attention pagination | two pages of 2, total 4 |
| Goal filter | `GOAL-2407` total 4 |
| running filter | total 1 |
| ETag revalidation | returned `304` |
| scope cleanup | 0 snapshots and 0 task rows remained |

The cleanup result was independently rechecked through the Neon control plane.
No pre-existing scope was modified.
