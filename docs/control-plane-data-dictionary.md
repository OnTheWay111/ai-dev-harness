# Control-plane data dictionary

P2-01 through P2-03 introduce the authoritative PostgreSQL write-model foundation.
These tables record business facts; `workbench_snapshots` and
`workbench_tasks` remain replaceable projections derived from them.

The current scope contains Organization, Project, Repository, Goal,
AcceptanceCriterion, Clarification, Decision, SpecRevision, Issue,
IssueDependency, Run, Evidence, AuditEvent, OutboxEvent, and
IdempotencyRecord.

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
- Large content is never stored on Evidence, AuditEvent, or idempotency rows;
  they carry credential-free references and SHA-256 digests.
- AuditEvent and Evidence rows are append-only. OutboxEvent and
  IdempotencyRecord have deliberately mutable delivery/command status.

See [ADR 0001](adr/0001-explicit-organization-keys.md) for the Organization-key
trade-off and [ADR 0002](adr/0002-append-only-planning-history.md) for the
append-only planning-history decision. [ADR 0003](adr/0003-reference-large-artifacts.md)
records the external-artifact boundary.

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
| `non_goals`, `constraints` | Bounded JSON string arrays defining explicit scope boundaries |
| `status` | `draft`, `clarifying`, `planning`, `approved`, `executing`, `verifying`, `completed`, or `cancelled` |
| `version` | Positive optimistic-lock version |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

`(organization_id, project_id, id)` is unique and is the target of
AcceptanceCriterion foreign keys.

Allowed transitions, guards, terminal states, and optimistic persistence are
defined in [Control-plane state machines](control-plane-state-machines.md).

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

## `runs`

One numbered execution attempt for a particular Issue revision.

| Column | Meaning |
|---|---|
| `id` | Run identity |
| `organization_id`, `project_id`, `goal_id`, `issue_id` | Complete Issue hierarchy |
| `attempt` | Positive, Issue-local attempt number |
| `status` | `queued`, `running`, `succeeded`, `failed`, or `cancelled` |
| `request_id` | Correlation identifier, never a Secret |
| `version` | Positive optimistic state-machine version |
| `started_at`, `finished_at` | State-consistent execution timestamps |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

The Issue/attempt tuple is unique. Status checks require timestamps appropriate
to queued, running, terminal, and cancelled attempts.

## `evidence`

Immutable metadata for a Run artifact.

| Column | Meaning |
|---|---|
| `id` | Evidence identity |
| `organization_id`, `project_id`, `goal_id`, `issue_id`, `run_id` | Complete Run hierarchy |
| `kind` | `artifact`, `log`, `test`, `review`, `commit`, or `push` |
| `artifact_ref`, `digest` | Credential-free immutable reference and SHA-256 digest |
| `media_type`, `size_bytes` | Artifact representation metadata |
| `retention_until` | Earliest policy expiry time |
| `created_at` | Immutable creation time |

PostgreSQL rejects updates and deletes. The same digest and kind is unique per
Run; artifact content is never stored in this table.

## `audit_events`

An immutable account of a control-plane mutation.

| Column | Meaning |
|---|---|
| `id` | Event identity |
| `organization_id`, `project_id`, `goal_id` | Hierarchical scope; Project and Goal are optional together |
| `actor_id` | Stable actor reference pending the P3 identity model |
| `action` | Audited action code |
| `entity_type`, `entity_id`, `entity_version` | Exact versioned subject |
| `reason`, `request_id` | Human/system rationale and request correlation |
| `details_ref`, `details_digest` | Optional external detail artifact |
| `retention_until`, `created_at` | Retention boundary and immutable event time |

Update and delete triggers prevent an application from rewriting audit history.

`actor_id` is the opaque, stable P3 OIDC actor identifier. It does not contain
an access, refresh, or ID Token.

## `role_bindings`

A versioned grant connecting one authenticated actor to one Organization or
Project role.

| Column | Meaning |
|---|---|
| `id`, `organization_id`, `project_id` | Grant identity and Organization/optional Project scope |
| `actor_id`, `role` | Opaque OIDC actor and one of Owner, Project Admin, Approver, Operator, Viewer |
| `assigned_by_actor_id`, `reason`, `request_id` | Traceable assignment authority and rationale |
| `version`, `revoked_at` | Optimistic revocation version and inactive timestamp |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

Partial unique indexes reject duplicate active Organization and Project grants.
Composite foreign keys prevent a Project binding from crossing its Organization.
Role scope checks require Owner at Organization scope and Project Admin at
Project scope. Role changes also append immutable AuditEvents.

## `outbox_events`

A durable event awaiting dispatch after its aggregate transaction commits.

| Column | Meaning |
|---|---|
| `id`, `organization_id` | Event identity and ownership boundary |
| `aggregate_type`, `aggregate_id`, `aggregate_version` | Exact source aggregate version |
| `event_type`, `deduplication_key`, `payload` | Dispatch contract and small structured payload |
| `status` | `pending`, `published`, or `failed` |
| `attempts`, `available_at`, `published_at`, `last_error_ref` | Retry and delivery metadata |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

The Organization/deduplication key and aggregate-version/event tuple are both
unique. P2 only records events; no asynchronous side effect is started.

## `idempotency_records`

A command receipt scoped by Organization, actor, endpoint, and Idempotency-Key.

| Column | Meaning |
|---|---|
| `id`, `organization_id` | Record identity and ownership boundary |
| `actor_id`, `endpoint`, `key` | Idempotency scope |
| `request_hash` | SHA-256 of the canonical command input |
| `status` | `in_progress`, `completed`, or `failed` |
| `response_status`, `response_ref`, `response_digest` | Replayable external response receipt after completion |
| `expires_at` | Expiry time, indexed for policy cleanup |
| `created_at`, `updated_at` | Ordered lifecycle timestamps |

The same key may be reused by another actor or endpoint but not inside an
existing scope. In-progress rows cannot masquerade as completed responses.
