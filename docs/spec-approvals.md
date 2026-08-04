# Specification approvals

P5-03 adds the human gate between generated Proposal/PRD revisions and Issue
compilation. The server owns the transition and authorization rules; hiding a
button in the workbench is never treated as authorization.

## Lifecycle and decisions

A newly generated `SpecRevision` is `draft`. An authorized actor first submits
that exact version for review, producing `in_review`. An authorized approver can
then approve, reject, or request changes. Approval produces `approved`; rejection
and change requests produce `rejected`, so regeneration appends a new immutable
revision instead of rewriting the reviewed artifact.

Every command carries the expected SpecRevision version, non-blank reason,
request ID, idempotency key, overdesign policy revision, and affected element
identities. The authenticated server context supplies the actor. A stale version,
changed policy, invalid lifecycle state, unknown element, blank reason, or missing
permission fails closed.

## Overdesign and scope rules

- `Required` elements are retained on approval.
- `Helpful` elements are removed unless the approver explicitly selects an
  exception and records a reason.
- `Speculative` elements are always removed. Neither Planner output nor an
  approval request can turn them into an exception.
- Scope changes are accepted only with `request_changes`. Each change is a
  bounded add/remove operation against a requirement, non-goal, or constraint.

The approval panel shows the category and rationale for each element, makes
Helpful retention opt-in, and identifies Speculative deletion as the default.
The API repeats all of these checks independently of the browser.

## Atomic record and replay

The PostgreSQL adapter locks the target SpecRevision, verifies its current
version and policy revision, updates its lifecycle version, and appends the
Decision, AuditEvent, and Outbox event in one transaction. The decision records
the affected, retained, and removed element IDs plus any scope changes.

`Idempotency-Key` is scoped to Organization, actor, and endpoint. Replaying the
same canonical command returns the stored receipt without a second transition;
reusing the key for a different command is a conflict. The GET approval endpoint
returns the immutable ordered history so the workbench can display actor, reason,
decision, policy, affected elements, and scope changes.

## HTTP surface

- `GET /api/v1/goals/{goalId}/specs/{specRevisionId}/approvals` lists the
  server-authorized approval timeline.
- `POST /api/v1/goals/{goalId}/specs/{specRevisionId}/approvals` records one
  transition. It requires same-origin protection, `X-Request-Id`, and
  `Idempotency-Key`; unknown body fields and any client `actorId` are rejected.

The implementation has in-memory unit coverage for permission denial, empty
reasons, optimistic concurrency, policy changes, default Speculative removal,
Helpful exceptions, scope changes, replay, and history. The PostgreSQL suite
also verifies the transaction and persisted receipt against the real schema.
