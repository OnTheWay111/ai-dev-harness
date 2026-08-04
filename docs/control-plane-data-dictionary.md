# Control-plane data dictionary

P2-01 and P2-02 introduce the authoritative PostgreSQL write-model foundation.
These tables record business facts; `workbench_snapshots` and
`workbench_tasks` remain replaceable projections derived from them.

The current scope contains Organization, Project, Repository, Goal,
AcceptanceCriterion, Clarification, Decision, SpecRevision, Issue, and
IssueDependency. Execution, audit, idempotency, and outbox records belong to
the next P2 delivery.

## Shared rules

- IDs are database-generated UUIDs and are stable entity identities.
- Every row has an optimistic `version`, starting at `1`, and ordered
  `created_at` / `updated_at` timestamps.
- Every Project-owned row carries `organization_id`; deeper rows also carry the
  applicable `project_id` and parent ID.
- Composite foreign keys include the Organization and Project keys, so a child
  cannot reference a parent from another boundary.
- Deletes and identity updates are restricted while children exist. Future
  application services must perform explicit archival or domain transitions.
- Human-readable values are non-blank and bounded; slugs and scoped identities
  are unique where they select a single entity.
- Clarification and Decision history is append-only. A changed answer or
  disposition creates a successor revision and PostgreSQL rejects mutation of
  earlier rows.
- SpecRevision and Issue keep content revisions distinct from their optimistic
  state-machine `version`.

See [ADR 0001](adr/0001-explicit-organization-keys.md) for the Organization-key
trade-off and [ADR 0002](adr/0002-append-only-planning-history.md) for the
append-only planning-history decision.

## `organizations`

The top-level ownership and authorization boundary.

| Column | Meaning |
|---|---|
| `id` | Primary UUID |
| `slug` | Globally unique, URL-safe organization name |
| `name` | Human-readable name |
| `version` | Positive optimistic-lock version |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

## `projects`

An Organization-owned delivery boundary.

| Column | Meaning |
|---|---|
| `id` | Primary UUID |
| `organization_id` | Owning Organization and isolation key |
| `slug` | Unique within the Organization |
| `name` | Human-readable name |
| `version` | Positive optimistic-lock version |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

`(organization_id, id)` is unique and is the target of Organization-aware child
foreign keys.

## `repositories`

A Project-scoped registration of a remote source repository. It stores no Git
credential or credential-bearing remote URL.

| Column | Meaning |
|---|---|
| `id` | Primary UUID |
| `organization_id`, `project_id` | Owning Organization and Project hierarchy |
| `provider` | V1 provider code; currently `github` |
| `provider_repository_id` | Stable provider-side repository identity |
| `owner`, `name` | Provider namespace and repository name |
| `default_branch` | Baseline branch name, not a ref credential |
| `version` | Positive optimistic-lock version |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

Provider identity and `owner + name` are each unique within one Project.

## `goals`

The authoritative Goal contract core for one Project.

| Column | Meaning |
|---|---|
| `id` | Primary UUID |
| `organization_id`, `project_id` | Owning Organization and Project hierarchy |
| `title` | Concise Goal name |
| `problem_statement` | Problem the Goal exists to address |
| `desired_outcome` | Observable result the Goal seeks |
| `version` | Positive optimistic-lock version |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

`(organization_id, project_id, id)` is unique and is the target of
AcceptanceCriterion foreign keys.

## `acceptance_criteria`

Ordered statements used later by Goal verification.

| Column | Meaning |
|---|---|
| `id` | Primary UUID |
| `organization_id`, `project_id`, `goal_id` | Owning Organization, Project, and Goal hierarchy |
| `position` | Positive display and evaluation order within the Goal |
| `statement` | Bounded, non-blank criterion text |
| `version` | Positive optimistic-lock version |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

`position` is unique within one Goal. Verification result and evidence do not
belong on this table; later entities record those facts without overwriting the
criterion.

## `clarifications`

An immutable revision in a Goal-scoped clarification thread.

| Column | Meaning |
|---|---|
| `id` | Immutable revision identity |
| `organization_id`, `project_id`, `goal_id` | Owning Goal hierarchy |
| `thread_id`, `revision` | Stable thread identity and positive revision number |
| `previous_clarification_id` | Prior revision in the same Goal; required after revision 1 |
| `status` | `open`, `answered`, or `superseded` |
| `question`, `answer` | Bounded question and state-consistent answer |
| `source_goal_version` | Goal version used to create the revision |
| `created_at` | Immutable creation time |

The Goal/thread/revision tuple is unique. Update and delete triggers force
callers to append a successor instead of rewriting history.

## `decisions`

An immutable, reasoned disposition of a versioned planning subject.

| Column | Meaning |
|---|---|
| `id` | Immutable decision revision identity |
| `organization_id`, `project_id`, `goal_id` | Owning Goal hierarchy |
| `decision_key`, `revision` | Stable decision identity and revision number |
| `previous_decision_id` | Prior revision in the same Goal |
| `status` | `proposed`, `approved`, `rejected`, or `superseded` |
| `subject_type`, `subject_id`, `subject_version` | Exact planning subject being decided |
| `outcome`, `reason` | Bounded result and rationale |
| `created_at` | Immutable creation time |

Decision revisions are append-only and cannot be updated or deleted.

## `spec_revisions`

A versioned, artifact-backed proposal derived from a particular Goal version.

| Column | Meaning |
|---|---|
| `id` | Spec revision identity |
| `organization_id`, `project_id`, `goal_id` | Owning Goal hierarchy |
| `revision`, `previous_revision_id` | Goal-local revision chain |
| `status` | `draft`, `in_review`, `approved`, `rejected`, or `superseded` |
| `source_goal_version` | Goal version used to generate the artifact |
| `artifact_ref`, `artifact_digest` | Credential-free immutable content reference and SHA-256 digest |
| `version` | Positive optimistic state-machine version |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

## `issues`

A versioned delivery unit sourced from one SpecRevision.

| Column | Meaning |
|---|---|
| `id` | Issue revision identity |
| `organization_id`, `project_id`, `goal_id` | Owning Goal hierarchy |
| `spec_revision_id` | Source SpecRevision inside the same Goal |
| `issue_key`, `revision`, `previous_issue_id` | Stable Goal-local key and content revision chain |
| `status` | `draft`, `approved`, `ready`, `in_progress`, `blocked`, `completed`, or `cancelled` |
| `title` | Bounded summary |
| `body_ref`, `body_digest` | Credential-free immutable content reference and SHA-256 digest |
| `version` | Positive optimistic state-machine version |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

## `issue_dependencies`

A directed prerequisite edge from `depends_on_issue_id` to `issue_id`.
Both composite foreign keys include Organization, Project, and Goal, so neither
endpoint can cross a Goal boundary. Self-edges and duplicates are rejected.
The domain edge projection is the input seam for the deterministic DAG
validator delivered later; the database intentionally does not attempt a
recursive cycle check.
