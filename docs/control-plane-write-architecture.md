# Control-plane write architecture

P2-05 and P2-06 provide one reliable Goal state-change vertical slice without
exposing an unauthenticated route before P3 identity and P4 Goal APIs exist.

## Module interface

`GoalApplicationService.transition(command)` is the application module's small
interface. A caller supplies an authenticated actor, Goal scope, request ID,
`Idempotency-Key`, `expectedVersion`, desired state, reason, and verified guard
facts. The module hides this sequence:

1. authorize the actor against the requested Goal transition before any Goal
   read, avoiding an unauthorized existence probe;
2. hash the canonical business command and replay a completed command with the
   same scoped key and hash before re-running the state machine;
3. load the authoritative Goal through `GoalRepository`;
4. execute the pure Goal state machine;
5. construct one versioned `goal.state_changed` event, Audit event, and
   protocol-neutral receipt;
6. atomically claim the key, update the Goal with `expectedVersion`, append the
   Audit and Outbox records, and complete the key;
7. return the receipt stored in the Outbox payload.

The domain module imports neither HTTP nor Drizzle/PostgreSQL. It returns state
and events rather than performing transport side effects.

## Repository seam and adapters

`GoalRepository` has three methods: `get(scope)`,
`findIdempotentReceipt(lookup)`, and `commitTransition(command)`. The commit
interface includes the previous aggregate, `expectedVersion`, next state,
occurrence time, event, Audit record, key claim, and receipt. Callers do not
manage SQL transactions or reliability-table inserts.

- `MemoryGoalRepository` is the deterministic local/test Adapter.
- `PostgresGoalRepository` is the production persistence Adapter. It uses a
  fixed parameterized optimistic update and inserts the idempotency claim,
  Audit record, and Outbox event in the same PostgreSQL transaction.

Both Adapters run the same contract: scoped load, one version increment, one
Audit, one Outbox event, exact replay, and stale-version failure without a
second event. PostgreSQL integration tests execute that contract against a
migrated temporary database.

## Reliability and transaction boundary

The key scope is `(organization, actor, endpoint, key)` and the canonical hash
excludes transport-only `requestId`, so a network retry can carry a new request
ID and still receive the exact first receipt. Reusing the key for a different
business command fails with `409 idempotency_conflict`. A missing or blank key
fails closed before persistence.

The PostgreSQL Adapter opens one transaction and performs this ordered write:

```text
IdempotencyRecord(in_progress)
  -> Goal UPDATE ... WHERE version = expectedVersion
  -> AuditEvent INSERT
  -> OutboxEvent(pending, receipt payload) INSERT
  -> IdempotencyRecord(completed, response reference + digest)
```

Any error rolls back all five effects. A concurrent identical command waits on
the unique key and replays the winner; concurrent commands with different keys
compete on the Goal version, and the loser rolls back its key claim. Outbox
records remain `pending`; P2-06 deliberately starts no dispatcher or other
asynchronous side effect.

## HTTP Adapter

`createGoalTransitionHandler` maps a trusted actor context, route scope, request
body, application receipt, and structured error envelope. It does not import
ORM tables, issue SQL, authorize, or reproduce state-machine rules. The Adapter
is intentionally not mounted as a public route yet: P3 supplies authenticated
actor resolution and request security, while P4 defines the public Goal API.

The handler maps missing keys to `400 validation_failed`, key reuse or an
in-progress collision to `409 idempotency_conflict`, stale versions to
`409 version_conflict`, and illegal transitions to `409 invalid_transition`.
