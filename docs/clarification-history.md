# Clarification history and human decisions

P4-04 treats clarification as an append-only review record. A Goal edit does
not rewrite any question or answer. It makes older questions stale, and a new
planner round must be appended against the new `Goal.version`.

## Records and version rules

- `clarification_rounds` records the planner run, source Goal version, known
  facts, uncertainties, actor, reason, and links to both the prior and the
  explicitly regenerated-from round.
- `clarifications` is a revision chain per `thread_id`. Revision 1 is the open
  planner question. Every human answer, including a corrected answer, inserts
  the next revision with `previous_clarification_id`; it never updates the old
  row.
- `decisions` is the matching human-decision chain. It records the server-side
  OIDC actor, reason, answer outcome, question revision, and prior decision.
- PostgreSQL rejects `UPDATE` and `DELETE` for all three history tables. Unique
  revision indexes plus row locks make one concurrent answer win and make the
  stale answer fail with a version conflict.

An answer is rejected as expired when its question is not from the newest
round or its `source_goal_version` differs from the authoritative Goal.

## API

- `GET /api/v1/goals/{goalId}/clarifications?organizationId=...&projectId=...`
  returns the complete authorized timeline.
- `POST /api/v1/goals/{goalId}/clarifications` appends a generated round. Body:
  `organizationId`, `projectId`, `expectedGoalVersion`, and `reason`.
- `POST /api/v1/goals/{goalId}/clarifications/{threadId}/answers` appends an
  answer and human decision. Body adds `expectedQuestionRevision`, `answer`,
  and `reason`.

Writes require same-origin requests and `goal.write`; reads require
`goal.read`. The actor always comes from the server-validated OIDC session.
Unknown fields are rejected, so a client cannot supply or override `actorId`.
No database URL, token, planner prompt, or model output is returned or logged.

## Running verification

From `prototype/web-ui`:

```sh
npm run db:check:drift
npm run test:postgres:integration
node --experimental-strip-types --test \
  tests/clarification-history.test.mjs \
  tests/clarification-history-handler.test.mjs
```

The PostgreSQL integration suite starts from an empty database, migrates it,
tests a concurrent answer race, and verifies the append-only database trigger.
