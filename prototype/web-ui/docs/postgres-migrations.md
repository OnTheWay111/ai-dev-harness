# PostgreSQL migration runbook and receipts

This runbook is the P1-02 source of truth for applying the committed
`drizzle-postgres` migrations without weakening the P1-01 role boundary. It
contains no connection URL or credential. Secret names, injection, and
rotation remain defined in [`postgres-environments.md`](postgres-environments.md).

## One-time ledger provisioning

The migration login assumes its `_migrator` capability role on connection. It
has `CREATE` in the application `public` schema, but it deliberately has neither
the PostgreSQL `CREATEDB` role attribute nor `CREATE` on the database. Because
the stock Drizzle migrator always tries `CREATE SCHEMA IF NOT EXISTS drizzle`,
an administrator must create the ledger once, before the migrator Secret is
used:

```sql
CREATE SCHEMA IF NOT EXISTS drizzle
  AUTHORIZATION ai_dev_harness_development_migrator;

CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);

ALTER SCHEMA drizzle
  OWNER TO ai_dev_harness_development_migrator;
ALTER TABLE drizzle.__drizzle_migrations
  OWNER TO ai_dev_harness_development_migrator;
ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq
  OWNER TO ai_dev_harness_development_migrator;

ALTER ROLE ai_dev_harness_development_migrator_a
  IN DATABASE ai_dev_harness_development
  SET ROLE TO 'ai_dev_harness_development_migrator';
ALTER ROLE ai_dev_harness_development_migrator_b
  IN DATABASE ai_dev_harness_development
  SET ROLE TO 'ai_dev_harness_development_migrator';

REVOKE CREATE ON DATABASE ai_dev_harness_development
  FROM ai_dev_harness_development_migrator;
```

Run provisioning only through the Neon administrator control plane. The
administrator credential is break-glass and must not enter a developer shell,
CI job, migration environment, receipt, or log. The equivalent test and
staging setup uses their environment-specific names.

`npm run db:migrate:postgres` reads the Drizzle journal and exact migration
files, calculates each SHA-256 digest, takes a transaction-scoped advisory
lock, and applies all missing statements plus the Drizzle ledger insert in one
atomic `DO` statement. It does not create the ledger. A statement failure rolls
back both schema changes and the ledger insert. A repeated run finds the same
timestamp and digest and performs no DDL. A timestamp with a different digest,
an out-of-order ledger, a missing ledger, or an incorrect role fails closed.

## Apply and verify

Use a Secret manager to inject the development migrator URL into one child
process. The URL is never a command argument and must not be copied into a
tracked env file.

```bash
HARNESS_DEPLOYMENT_ENV=development \
HARNESS_POSTGRES_ENDPOINT_ID=<development-endpoint-id> \
<secret-manager-exec> -- \
  npm run db:migrate:postgres

HARNESS_DEPLOYMENT_ENV=development \
HARNESS_POSTGRES_ENDPOINT_ID=<development-endpoint-id> \
<secret-manager-exec> -- \
  npm run db:check:migration:postgres
```

Run these commands from `prototype/web-ui`. The migration check validates the
Drizzle ledger digest, table/column/index shape, object ownership, app grants,
migrator least privilege, and the committed development receipt. It prints
only a pass/fail summary and suppresses driver details on failure.

To check that the TypeScript schema and committed Drizzle metadata have not
drifted, run `npm run db:check:drift`. It generates into an operating-system
temporary directory, compares digests, and leaves the worktree unchanged. Do
not commit a newly generated migration merely to make a check green; review the
schema change as a separate delivery item.

## Receipt contract

Receipts live under `migration-receipts/<environment>/`. A successful receipt
records only:

- receipt schema version, environment, and database name;
- applied Drizzle migration tag, journal timestamp, and SHA-256 digest;
- application and verification timestamps in UTC;
- the result plus empty-database, repeat-run, drift, and rollback checks.

A receipt must never contain a connection URL, hostname, password, Secret
value, or raw driver error. Failed attempts do not produce a successful
receipt. Receipts are immutable evidence: a later migration creates a new file
instead of rewriting an earlier result. Receipt verification resolves the
recorded journal entry and digest, so historical receipts remain valid after
new migrations are committed.

The development receipt
`migration-receipts/development/0000_tan_mikhail_rasputin.json` records the
P1-02 execution. Before application, `public` contained zero base tables and
the Drizzle ledger did not exist. The committed migration was then applied from
empty state. A second application was a no-op. A transaction that created a
probe table and inserted a probe ledger row before raising an error left
neither object behind. The final live check found one matching ledger row, the
two expected tables, all six expected indexes, no drift, and least-privilege
ownership and grants.
