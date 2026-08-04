# Issue plan contract and compiler

P6 turns one latest, approved `SpecRevision` into an auditable
`issue-plan.v1`. The model can propose Issue drafts; deterministic TypeScript
rules decide whether the plan is approvable.

## Generated Issue contract

The closed `issue-plan-draft.v1` schema requires every Issue to carry:

- a stable key, title, goal, requirement references, acceptance references,
  non-goals, and dependency candidates;
- expected files and explicit directory, public-interface, database-object,
  shared-configuration, and landing-order resource claims;
- a self-contained development prompt that repeats the goal, traceability IDs,
  acceptance statements, non-goals, expected files, and verification commands;
- verification commands and typed, mandatory completion-evidence requirements.

Unknown fields, duplicate keys/references, weak prompts, and plans without any
mandatory evidence fail before persistence. The saved source records the exact
SpecRevision ID/version/digest and Planner run/configuration.

## Deterministic compiler

`issue-compiler.v1` checks both directions of requirement and acceptance
coverage. It returns stable paths, diagnostic codes, affected Issue keys, and
delivery impact for:

```text
duplicate_issue_key
unknown_requirement_ref
unknown_acceptance_ref
acceptance_without_requirement
orphan_issue
uncovered_requirement
uncovered_acceptance
missing_dependency
self_dependency
duplicate_dependency
dependency_cycle
```

Any diagnostic blocks approval and external projection. A valid graph receives
a stable dependency-first topological order.

## Conflict analysis and Waves

`issue-conflicts.v1` produces an explainable conflict graph from exact file
paths, explicit directory claims, public interfaces, database objects, shared
configuration, and landing-order keys. File-prefix similarity alone is not a
conflict. A greedy stable scheduler places alphabetically ordered ready Issues
into the earliest Wave where all dependencies are complete and no pair has a
resource conflict.

## Model routing

`model-router.v1` scores risk, expected file scope, domain complexity, and
verification difficulty. It saves only capability tier and reasoning effort;
runtime aliases resolve concrete models outside the Issue. Human overrides
require actor, reason, and timestamp. High-risk recommendations cannot be
silently downgraded, and an unavailable required tier blocks execution.

## Revision and approval API

```text
GET   /api/v1/goals/:goalId/issue-plans
POST  /api/v1/goals/:goalId/issue-plans
PATCH /api/v1/goals/:goalId/issue-plans/:planId
POST  /api/v1/goals/:goalId/issue-plans/:planId/approvals
POST  /api/v1/goals/:goalId/issue-plans/:planId/queue-projections
```

Every edit creates a new revision and reruns compilation, conflicts, Waves, and
routing. Approval binds all Issue keys, the complete plan digest, optimistic
version, trusted session actor, reason, request ID, idempotency key, and
`issue-plan-approval.v1`. Stale writes return 409 without replacing the
browser-owned draft. PostgreSQL stores the plan revision, normalized model
recommendations and Waves, decisions, audit/outbox events, idempotency records,
and successful queue projection receipts.

Projection accepts only the latest approved plan. Browser retries reuse a
plan-and-digest idempotency key, and persisted receipts are also deduplicated
by plan digest so a new request key cannot repeat a completed external import.
