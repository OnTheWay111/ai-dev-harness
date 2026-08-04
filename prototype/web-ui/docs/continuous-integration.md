# P1 PostgreSQL continuous-integration gate

The `P1 PostgreSQL gate` workflow runs for pushes and pull requests targeting
`main`. Any failed step makes the job fail, so it can be selected as a required
status check in the repository's branch-protection rules.

The job has read-only repository permission and an isolated PostgreSQL 16
service container. The container uses trust authentication only inside the
disposable GitHub-hosted runner network, so the workflow contains no database
password or persistent credential. It executes, in order:

1. schema-to-migration drift generation in a temporary directory;
2. P1-04 empty-database migration and five real PostgreSQL integration cases;
3. the production build and full automated test suite;
4. TypeScript and ESLint checks; and
5. a scan of every `dist/client` file for connection URLs, database Secret
   names, and server-only Neon/Drizzle driver markers.

All database lifecycle commands suppress raw connection errors. The drift
checker logs only changed migration paths, and the client scanner logs only a
rule label and relative artifact path. Neither logs matching file contents,
environment values, connection details, or driver exceptions.

## Local equivalent

From `prototype/web-ui`, run:

```bash
npm ci
npm run ci:p1
```

When `POSTGRES_TEST_ADMIN_URL` is absent, the integration runner creates a
private local PostgreSQL cluster with `initdb`, migrates a unique database, then
drops the database and removes the cluster. CI injects the URL of its disposable
service container only into the server-side job environment.

The drift check never changes committed migration files: it copies them into a
validated operating-system temporary directory, generates against the current
schema there, compares SHA-256 digests, and destroys the copy. The client scan
must run after `npm test`, because that command creates the production build.
