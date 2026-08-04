# Immutable specification artifacts

P5 generates one strict `spec-bundle.v1` document containing the Proposal,
PRD, architecture, migration, rollback, and traceable solution-element drafts.
Planner output never becomes an approval: the server validates the closed JSON
Schema and referential integrity before storing anything.

Each validated solution element is then classified by
`overdesign-policy.v1`. A valid acceptance-criterion reference is Required; an
evidenced reference to a declared Goal constraint is Helpful; everything else
is Speculative and removed by default at approval. Unknown references never
become Required. The immutable review records valid references, estimated cost,
removal impact, evidence, rationale, category counts, and policy revision next
to the SpecRevision metadata.

## Persistence boundary

`SpecGenerationService` writes content through the `ArtifactStore` port before
appending a `SpecRevision`. The artifact is addressed by SHA-256, is immutable,
and records media type, byte size, creation time, and the authenticated actor.
PostgreSQL stores only the credential-free reference, digest, source Goal
version, Planner run/configuration, and generation time.

- Demo mode uses the process-local memory adapter.
- PostgreSQL mode requires an absolute `ARTIFACT_STORE_PATH` on a durable,
  server-only mounted volume and fails closed when it is absent.
- Reusing identical content returns the existing digest without replacing its
  original creation metadata.
- A changed or regenerated document appends a new `SpecRevision`; prior content
  and metadata remain readable.

The filesystem adapter is the first production-shaped adapter behind the port.
A managed object-store adapter can replace it without changing domain or API
contracts; deployments must not use ephemeral container storage.

## API and verification

`GET /api/v1/goals/{goalId}/specs` returns the authorized immutable revision
timeline. `POST` generates a new draft from the exact `expectedGoalVersion`.
Both are no-store responses; writes apply same-origin checks, strict body
validation, server-derived identity, RBAC, rate limiting, and stable errors.

Run locally:

```bash
npm run test:unit
npm run typecheck
npm run db:check:drift
```

The real Codex smoke tests are opt-in and always use a new ephemeral read-only
session:

```bash
RUN_CODEX_PLANNER_SMOKE=1 npm run test:planner:smoke
```
