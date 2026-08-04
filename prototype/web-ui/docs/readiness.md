# PostgreSQL readiness

`GET /health/ready` is the deployment readiness gate for the workbench read
model. It returns `200` only after both of these checks pass:

1. configuration resolves to the PostgreSQL repository; and
2. the configured scope has a readable workbench projection.

The probe uses a one-row projection read and sets `Cache-Control: no-store`.
It does not run migrations or write data.

## Fail-closed deployment rules

- Managed `development`, `test`, and `staging` environments continue to use
  the strict P1-01 mapping. `staging` is the pre-production environment.
- A runtime with `NODE_ENV=production` must set
  `WORKBENCH_DATA_SOURCE=postgres` and inject `DATABASE_URL` server-side.
- A managed environment also validates the Neon endpoint, database, A/B login
  role, and exact workbench scope before any connection attempt.
- Demo mode remains available for local UI development, but it never passes
  database readiness.

Missing configuration, connection failure, and a missing projection all return
`503`. The response reports only pass/fail/skipped check states, a stable error
code, and a request ID. It never includes a connection URL, Secret name, raw
driver error, database host, role, or scope. Ordinary workbench API failures use
the existing structured error envelope and likewise do not log raw exceptions.

## Safe checks

No credentials are required to prove failure-closed behavior:

```bash
curl --fail-with-body http://localhost:3000/health/ready
```

The command is expected to return `503` when the server has no PostgreSQL
configuration. A deployment platform should remove an instance from service on
any non-`200` result.

For a real development-database verification, inject the P1-01 app Secret into
the server process and run:

```bash
npm run verify:postgres:development
```

That command creates an isolated scope, verifies SSR, API, and the ready probe,
then deletes and independently checks the scope. It suppresses connection
details on failure.
