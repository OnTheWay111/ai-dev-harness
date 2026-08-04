# Deterministic delivery classification

P4-05 classifies an authoritative Goal with the versioned
`classification-policy.v1` rule set. Planner/model output cannot submit a size,
risk, Gate, Artifact, or approver value. The server accepts only a Goal version
and reason, reloads the Goal and saved clarification state, and computes every
output from the rules below.

## Version 1 rules

Size is the sum of these points:

| Input | Points |
|---|---:|
| 1–2 / 3–5 / 6–10 / 11+ acceptance criteria | 1 / 2 / 4 / 7 |
| 0 / 1–2 / 3–5 / 6+ constraints | 0 / 1 / 2 / 3 |
| One or more unresolved clarification questions | 1 |

The size bands are S `0–1`, M `2–3`, L `4–7`, and XL `8+`.

Risk factors are exact English/Chinese, case-normalized keyword groups plus authoritative open
question state:

| Factor | Points |
|---|---:|
| Security, identity, credential, Secret, token, RBAC, or OIDC | 2 |
| Schema or migration | 2 |
| Production deployment or rollout | 2 |
| Deletion, destructive change, or data loss | 4 |
| Unresolved high / blocker question | 2 / 4 |

Risk bands are low `0–1`, medium `2–4`, and high `5+`. Each result stores the
factor code, points, and explanation, so the UI never has to reverse-engineer
the decision.

Every result requires Proposal, PRD, and Test Plan. L/XL adds an ADR; migration
adds Migration and Rollback Plans; medium/high adds Risk Assessment; high adds
Recovery Plan. Low S/M requires Project Approver. L/XL or medium/high also
requires Technical Approver. High additionally requires Organization Approver.

## Persistence and API

The SHA-256 digest of the canonical policy definition identifies immutable
`classification_policy_revisions`. A Goal classification points to that exact
policy, Goal version, prior classification, actor, and reason. Both PostgreSQL
tables are append-only. Reclassification creates a successor rather than
updating the prior result.

- `GET /api/v1/goals/{goalId}/classifications` returns the authorized history.
- `POST /api/v1/goals/{goalId}/classifications` accepts only scope,
  `expectedGoalVersion`, and `reason` and appends a server-computed result.

Golden fixtures and explicit boundary cases run in
`tests/deterministic-classification.test.mjs`. The PostgreSQL integration suite
verifies policy deduplication, revision appends, and mutation rejection.
