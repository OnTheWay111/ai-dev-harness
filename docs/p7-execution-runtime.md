# P7 execution runtime

P7 runs as an independent Node process (`npm run scheduler:p7`); no AutoDev
task is kept inside an HTTP request. PostgreSQL is authoritative for Scheduler
Jobs, nodes, leases, controls, Inbox events, Run transitions, and Outbox events.
AutoDev remains authoritative for Builder/Verify/Review/Worktree/Landing
execution details.

Each loop first discovers `ready` Issues from a completed formal Queue
Projection, rechecks dependency completion, resolves the approved capability
route, and idempotently creates the Run and Scheduler Job in one transaction.
The configured machine actor is accepted only by this internal worker boundary.

## Recovery order

Every scheduler tick uses this order:

1. expire stale node/Run leases and find reconciliation-required Jobs;
2. inspect or cancel those external Runs before considering new work;
3. renew leases owned by the current supervisor;
4. claim one dependency-ready, policy-allowed Job with `FOR UPDATE SKIP LOCKED`;
5. select a live node that explicitly advertises the approved capability,
   recheck capacity, and create one active Run lease;
6. persist deterministic external Run identity before process launch;
7. launch AutoDev and consume its versioned event journal through Inbox.

The partial unique index on active lease `run_id` is the final database guard
against two valid owners. A crash after external launch leaves the Job in
`starting` with `reconciliation_required=true`; a replacement supervisor uses
the deterministic external Run ID and does not issue another launch.

## Budgets, retries, and controls

`deadline_at`, `max_attempts`, `budget.maxRuntimeSeconds`, exponential retry
delay, process timeout, lease expiry, and node capacity are enforced
independently. A Gateway start failure
releases capacity before entering `retry_wait`; the third consecutive project
failure opens a five-minute circuit. Terminal failure updates Run and Outbox in
the same transaction.

Operator commands are `start`, `pause`, `drain`, `resume`, `retry`, and `stop`.
They require authorization, reason, expected version, request ID, and
idempotency key. Their append-only command receipt doubles as the replay and
audit record. Global Stop has highest priority, followed by project Stop,
circuit, budget/deadline, pause, and drain. Pause/drain never kill an active
Verify, Review, or Landing phase; Stop can cancel non-safe active work.

## Event mapping

Each AutoDev source event is stored with source event ID, SHA-256 digest,
external Run ID, task ID, and sequence. Exact replay is ignored, identity reuse
with different content fails, gaps set `reconciliation_required`, missing
events are drained in order when they arrive, and terminal Runs never regress.
Accepted Run transitions and Outbox rows commit in the same PostgreSQL
transaction.

## Required runtime configuration

All paths are absolute and all credentials remain server-side. In addition to
the normal deployed PostgreSQL variables, the process requires:

- `AUTODEV_PYTHON`, `AUTODEV_PROJECT_CONFIG`, `AUTODEV_REPOSITORY_ROOT`;
- `AUTODEV_NETWORK_WRAPPER` and JSON array
  `AUTODEV_NETWORK_WRAPPER_ARGS_JSON`;
- `EXECUTION_NODE_ID`, `EXECUTION_NODE_NAME`, JSON capability list and capacity;
- unique `SCHEDULER_SUPERVISOR_ID`;
- `SCHEDULER_ADMISSION_ACTOR_ID`, admission batch size, default maximum
  attempts, runtime seconds, and optional cost ceiling;
- comma-separated names in `AUTODEV_EXECUTION_SECRET_NAMES`; each named value
  is injected from the server Secret store, never from client variables.
