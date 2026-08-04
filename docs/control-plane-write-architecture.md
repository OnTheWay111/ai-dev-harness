# Control-plane write architecture

P2-05 provides one Goal state-change vertical slice without exposing an
unauthenticated route before P3 identity and P4 Goal APIs exist.

## Module interface

`GoalApplicationService.transition(command)` is the application module's small
interface. A caller supplies an authenticated actor, Goal scope, request ID,
`expectedVersion`, desired state, reason, and verified guard facts. The module
hides this sequence:

1. authorize the actor against the requested Goal transition before any Goal
   read, avoiding an unauthorized existence probe;
2. load the authoritative Goal through `GoalRepository`;
3. execute the pure Goal state machine;
4. construct one versioned `goal.state_changed` event;
5. atomically commit the optimistic Goal update and Outbox event;
6. return a protocol-neutral receipt.

The domain module imports neither HTTP nor Drizzle/PostgreSQL. It returns state
and events rather than performing transport side effects.

## Repository seam and adapters

`GoalRepository` has two methods: `get(scope)` and
`commitTransition(command)`. The commit interface includes the previous
aggregate, `expectedVersion`, next state, occurrence time, and event. Callers do
not manage SQL transactions or Outbox inserts.

- `MemoryGoalRepository` is the deterministic local/test Adapter.
- `PostgresGoalRepository` is the production persistence Adapter. It uses a
  fixed parameterized optimistic update and inserts the Outbox event in the
  same PostgreSQL transaction.

Both Adapters run the same contract: scoped load, one version increment, one
event, and stale-version failure without a second event. PostgreSQL integration
tests execute that contract against a migrated temporary database.

## HTTP Adapter

`createGoalTransitionHandler` maps a trusted actor context, route scope, request
body, application receipt, and structured error envelope. It does not import
ORM tables, issue SQL, authorize, or reproduce state-machine rules. The Adapter
is intentionally not mounted as a public route yet: P3 supplies authenticated
actor resolution and request security, while P4 defines the public Goal API.

P2-06 deepens the same application/repository module with Idempotency-Key,
AuditEvent, replayable receipts, and additional rollback guarantees; it does
not add asynchronous Outbox dispatch.
