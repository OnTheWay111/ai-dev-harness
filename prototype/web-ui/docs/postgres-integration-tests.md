# Temporary PostgreSQL integration tests

P1-04 adds a real PostgreSQL integration path for the workbench projection. It
does not use an in-memory or fake store.

## Local execution

Run from `prototype/web-ui`:

```bash
npm run test:postgres:integration
```

With no extra configuration, the runner:

1. creates a private PostgreSQL cluster under the operating system temporary
   directory using `initdb` and a random local port;
2. creates a uniquely named empty database;
3. provisions the Drizzle ledger and applies the committed
   `drizzle-postgres` migration from empty state;
4. injects the temporary database URL into only the test child process;
5. runs the real TCP projection writer and repeatable-read repository tests;
6. verifies all test scopes were deleted, drops the database, stops the cluster,
   and removes its validated temporary directory.

The command returns non-zero if tests or cleanup fail. It never prints the
database URL or raw connection error.

## CI execution

CI can provide an already-running PostgreSQL administrator connection through
`POSTGRES_TEST_ADMIN_URL`. The runner still creates and drops a unique database,
so parallel jobs do not share tables or projection scopes:

```bash
POSTGRES_TEST_ADMIN_URL=<injected-admin-url> \
  npm run test:postgres:integration
```

The value must be injected as a server-side job Secret and must not be a command
argument, build argument, artifact, or logged value.

## Covered behavior

- migration from an empty database and exact Drizzle ledger digest;
- atomic projection replacement and consistent revision/task reads;
- Goal, lifecycle stage, and attention filters;
- stable cursor pagination and out-of-range/invalid cursors;
- empty projection failure instead of Demo fallback;
- a real connection refusal;
- rollback after snapshot replacement and task deletion when a later task
  insert fails, proving the prior projection remains intact;
- one-transaction Goal, Audit, Outbox, and IdempotencyRecord persistence;
- exact receipt replay and one pending Outbox record for sequential and
  concurrent duplicate commands;
- concurrent `expectedVersion` conflict with the losing key claim rolled back;
- full rollback of Goal and reliability records after a forced Audit failure.

The standard `npm test` run discovers the integration test file but skips it
when `POSTGRES_INTEGRATION_DATABASE_URL` is absent. The lifecycle runner is the
required command for executing the 13 real-database cases, including the P2
Organization boundary, write-model constraints, state transitions, and command
reliability guarantees.
