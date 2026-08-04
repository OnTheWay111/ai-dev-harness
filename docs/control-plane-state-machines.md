# Control-plane state machines

P2-04 keeps lifecycle rules in `app/control-plane/domain/state-machines.ts`.
Handlers and persistence adapters must not recreate or bypass these rules. A
transition first verifies `expectedVersion`, rejects terminal entities, checks
the declared edge and guard, then returns the next state with `version + 1`.

## Goal

| From | To | Guard |
|---|---|---|
| `draft` | `clarifying` | — |
| `clarifying` | `planning` | all clarification threads resolved |
| `planning` | `approved` | an approved SpecRevision exists |
| `approved` | `executing` | the Issue plan is approved |
| `executing` | `verifying` | all required Issues are complete |
| `verifying` | `completed` | acceptance verification passed |
| any non-terminal state | `cancelled` | a reason is present |

`completed` and `cancelled` are terminal.

## SpecRevision

| From | To | Guard |
|---|---|---|
| `draft` | `in_review` | artifact digest verified |
| `in_review` | `approved` | approval recorded |
| `in_review` | `rejected` | a reason is present |
| `draft`, `in_review`, or `approved` | `superseded` | a replacement exists |

`rejected` and `superseded` are terminal. An approved revision can only be
superseded; its artifact content is never mutated.

## Issue

| From | To | Guard |
|---|---|---|
| `draft` | `approved` | source SpecRevision is approved |
| `approved` | `ready` | dependencies are satisfied |
| `ready` | `in_progress` | — |
| `in_progress` | `blocked` | a reason is present |
| `blocked` | `ready` | dependencies are satisfied again |
| `in_progress` | `completed` | completion evidence exists |
| any non-terminal state | `cancelled` | a reason is present |

`completed` and `cancelled` are terminal.

## Run

| From | To | Guard |
|---|---|---|
| `queued` | `running` | — |
| `running` | `succeeded` | completion evidence exists |
| `running` | `failed` | a reason is present |
| `queued` or `running` | `cancelled` | a reason is present |

`succeeded`, `failed`, and `cancelled` are terminal.

## Persistence contract

The PostgreSQL state store uses fixed parameterized SQL and scopes every write
by the entity hierarchy plus `version = expectedVersion`. A successful update
increments the version exactly once and updates lifecycle timestamps. Matching
no row is always reported as a version conflict; a stale caller cannot overwrite
a concurrent transition. Database state checks and unique constraints remain a
second line of defense, not a replacement for the domain state machine.

Every edge not listed above is forbidden. Missing guards, transitions out of a
terminal state, unknown edges, and stale versions fail before a new state is
returned.
