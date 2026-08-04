# Goal Workspace contract and API

P4 turns an authenticated Project member's rough request into a versioned Goal
Contract. PostgreSQL remains authoritative; browser storage is only a recovery
copy for unsaved form input.

## Contract

A Goal draft contains a bounded title, problem statement, desired outcome, one
or more ordered acceptance criteria, and optional non-goals and constraints.
The server trims and validates every value, rejects duplicate or unknown fields,
and stores non-goals and constraints as JSON arrays. Acceptance criteria remain
ordered child records.

`version` is the optimistic-lock value. A successful edit increments it once;
an edit with a stale `expectedVersion` returns `version_conflict` and changes no
Goal, criterion, AuditEvent, OutboxEvent, or idempotency record.

## HTTP API

- `POST /api/v1/goals` creates a draft and returns HTTP 201.
- `GET /api/v1/goals/{goalId}?organizationId=...&projectId=...` reads it.
- `PATCH /api/v1/goals/{goalId}` replaces the editable contract fields using
  `expectedVersion` and returns the next version.

Writes require same-origin JSON, `Idempotency-Key`, an authenticated OIDC actor,
`goal.write`, and a bounded human reason. Reads require `goal.read`. Organization
and Project IDs select a requested scope but never grant access: the server
derives the actor and evaluates active RoleBindings before repository access.

The Goal, ordered criteria, immutable AuditEvent, Outbox event, and completed
idempotency receipt commit in one PostgreSQL transaction. Repeating the same
actor-scoped command returns the original receipt; changing its body under the
same key fails closed.

## UI and draft recovery

The Clarify view is an accessible Goal Contract form. Input is copied to a
Project-scoped `localStorage` key so a reload does not discard unsaved work. The
copy contains contract text only—never database URLs, tokens, cookies, or other
Secrets. Once saved, the UI records only the last Goal ID and reloads the
authoritative server version. A conflict preserves local text and asks the user
to reload before retrying.

Local demo mode uses an in-process adapter. Managed and production modes require
`DATABASE_URL`, the PostgreSQL repository, and server-side RBAC; they cannot
fall back to the demo adapter.
