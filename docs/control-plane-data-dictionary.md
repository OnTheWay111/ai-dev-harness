# Control-plane data dictionary

P2-01 introduces the first authoritative PostgreSQL write-model tables. They
record business facts; `workbench_snapshots` and `workbench_tasks` remain
replaceable projections derived from these and later authoritative entities.

The scope is deliberately limited to Organization, Project, Repository, Goal,
and AcceptanceCriterion. Lifecycle states, users, approvals, clarifications,
issues, execution, audit, idempotency, and outbox records belong to later P2+
deliveries.

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

See [ADR 0001](adr/0001-explicit-organization-keys.md) for the Organization-key
trade-off.

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
