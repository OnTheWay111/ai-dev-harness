# AutoDev Harness

AutoDev Harness is a local-first development harness for Git projects. It
keeps execution, verification, independent checking, and Git checkpoints on
the developer machine.

This is the standalone harness formerly embedded in the testing-super-agent
project. It is a reusable consumer package rather than source-project-specific
code. Version 0.3 adds fail-closed review/policy gates, lease-bound queue
finalization, per-run Git worktrees, process-group cancellation, durable state
writes, project-scoped runtime leases, and guarded notification egress.
Version 0.4 adds bounded per-project worker processes, a cross-project host
capacity broker, and serialized candidate landing with a recovery ledger.

For teammate onboarding, installation, first-project setup, daily operations,
and the recommended three-project parallel configuration, see the
[AutoDev Harness user guide](docs/autodev_harness_user_guide.md).

## Development install

```bash
python -m pip install -e ".[dev]"
autodev --help
autodev --version
```

## CLI

The installed `autodev` command exposes:

```text
init  run-one  run-loop  status  schedule  dashboard  doctor  queue  queue-import-server  registry  database
```

`queue` contains `summary`, `next`, `claim`, `done`, `block`, `resume`,
`propose`, and `approve`. Queue `done` runs the task's verify commands before
changing state unless an explicitly audited skip/empty override is supplied.

### Atomic Issue Plan import

`queue-import-server` is the formal server-side boundary for importing an
approved AI Dev Harness Issue Plan. It accepts one authenticated
`autodev-queue-import.v1` request at `POST /api/v1/queue/import`, validates the
complete dependency graph and capability route before mutation, and returns a
durable Issue-to-Queue-task receipt. The YAML backend writes every task and the
receipt in one locked atomic replacement; the database backend commits them in
one transaction. Replays by idempotency key or plan identity return the first
receipt without adding tasks, while conflicting reuse returns HTTP 409.

The bearer token is read only from the server process environment. It is never
accepted as a CLI argument and request logging is disabled:

```bash
export AUTODEV_QUEUE_IMPORT_TOKEN='replace-with-a-random-server-secret'
autodev queue-import-server \
  --project /path/to/repo/.autodev/project.yaml \
  --host 127.0.0.1 --port 8766
```

Configure the control plane with the server-side endpoint
`http://127.0.0.1:8766/api/v1/queue/import` and the same secret. Keep the
default loopback binding unless a TLS-authenticated private proxy protects the
service. Rotate the token by stopping the import server, changing the secret in
both server-side secret stores, and restarting the service; remove the old
value from the environment afterward. Do not put the token in project YAML,
command arguments, logs, or browser variables. `GET /healthz` exposes only an
unauthenticated boolean liveness response.

Dashboard activity is driven by explicit AutoDev/queue state, never by scanning
Claude/Codex process arguments. A manual or external worker must claim the task
before starting work so the queue is `in_progress` and the Dashboard can show
`外部处理中` with its owner:

```bash
autodev queue claim H-482 --owner cc --note "manual repair after review"
```

`queue resume` only moves a blocked task back to `pending`; it does not mean a
worker is active. A queue with pending work but no claim is shown as
`待处理·尚未领取 (pending)`, while `Harness 空闲` is reserved for projects with
neither an active controller nor pending/in-progress tasks.

A failed standalone `run-one` is continued explicitly from its preserved
candidate instead of silently starting over from the integration branch:

```bash
autodev queue resume H-485 --note "continue after review"
autodev run-one --task H-485 --retry-from 20260718-h485-attempt-01
```

AutoDev restores the failed run's candidate diff and injects its builder,
verification, and review artifacts into the next prompt. The queue keeps one
failure counter across run IDs; reaching `policy.same_task_failures_before_block`
blocks another attempt until a human performs an audited reset:

```bash
autodev queue resume H-485 --reset-failure-budget --note "reviewed root cause"
```

When the failed run recorded a healthy builder session and the configured
builder identity is unchanged, a same-task retry also prefers that Codex
session. The new Run/worktree remains isolated, but the builder receives the
repair prompt in its original conversation. Claude print-mode sessions are
cwd-scoped and therefore stay fresh across AutoDev's per-run worktrees instead
of making a resume call that cannot succeed. If provider-side resume exits
unsuccessfully, AutoDev uses the remaining builder timeout for one fresh-session
fallback; account quota/rate-limit failures do not waste a fallback call.
Evaluator sessions are never reused, and every repaired candidate still reruns
normal Verify and independent Review. Set `policy.builder_session_retry: fresh`
to opt out while retaining candidate/evidence recovery.

If the integration branch advanced since the failed candidate was created,
three-way restoration keeps cleanly applicable edits and hands explicit text
content-conflict markers to the retry builder. The retry must resolve those
files and still pass normal verify, independent review, and landing gates;
invalid patches or conflict shapes without an auditable unmerged-file set
remain blocked. AutoDev also rejects a builder that reports completion while
those restored files still contain Git conflict markers.

An independent-review failure also leaves a durable review gate on the task.
Resuming does not clear that gate, and manual `queue done` reconciliation is
rejected; only a normal lease-bound AutoDev completion after a green review
clears it. Historical failed runs that were closed manually—including legacy
queue rows without a completion marker—are shown as amber
`后续由人工完成 (manual_done)` rather than being recolored as successful runs;
the historical Harness result remains visible underneath.

## Parallel execution

Each project still has exactly one authoritative `run-loop` supervisor. Set
the project and queue limits to the same value to let that supervisor run two
or three dependency-ready tasks in isolated child processes:

```yaml
execution:
  max_parallel_tasks: 2       # 1..3; omitted means the compatible serial mode
  stop_behavior: drain        # drain | halt_before_landing
  circuit_breaker: cancel_and_requeue
queue:
  max_in_progress: 2
```

The queue file's `policy.max_in_progress` must also be `2`; configuration load
fails before any agent starts when the two values disagree. A one-off
`autodev run-loop --parallel N` may reduce or select concurrency, but may not
exceed `execution.max_parallel_tasks`.

Parallel mode requires a machine-wide policy at
`${XDG_CONFIG_HOME:-~/.config}/autodev/host.yaml`:

```yaml
schema_version: 1
host:
  max_active_workers: 4
  provider_limits:
    claude: 2
    codex: 2
  fairness: fifo_per_project
  global_stop_file: ~/.config/autodev/STOP
```

Separate projects can run their supervisors concurrently. The file-backed host
broker atomically limits their combined worker, provider, and task
`exclusive_resources` usage. Work and first-pass review run in separate
worktrees; candidates enter one project-local landing lane for rebase, final
verification, conditional independent re-review, integration-ref CAS, and
queue CAS. The durable ledger under `.autodev/runtime/landings/` recovers a
crash between Git integration and queue finalization.

The Dashboard remains a single read-only view: it shows global host/provider
occupancy, each project's active/allowed workers, and each child task phase.
Every logical run keeps its Worker → task → child run → builder/evaluator model
mapping after completion, with the serialized landing lane shown separately.
Database-backed recent Runs are ordered by the Run snapshot's logical update
time rather than by historical import time. The completed-task KPI links to a
read-only queue history filtered to `done`, with completion time and the latest
queue note; `skipped` history is available from the same task view.
`max_tasks` (tasks processed in one loop), same-task retry budget, loop time,
account usage quota, context Token limit, and provider rate limit use distinct
Chinese labels and keep the raw technical status as secondary text.
Without a host policy, serial compatibility remains available and the page
explicitly labels global capacity as uncontrolled; parallel startup fails
loudly instead of presenting a false capacity number.

## Optional PostgreSQL foundation

File persistence remains the default and the base wheel has no database
dependency. Install the optional extra only on a host that will use the
PostgreSQL shadow/database rollout:

```bash
python -m pip install "autodev-harness[postgres]"
```

For a fresh PostgreSQL instance, a cluster administrator can create the
physical database and its two least-privilege login roles with the idempotent
bootstrap script. Passwords are read only from the process environment; they
must not be supplied as psql variables because command lines and psql history
are easier to expose:

```bash
export AUTODEV_MIGRATOR_PASSWORD='replace-with-migration-role-password'
export AUTODEV_APP_PASSWORD='replace-with-runtime-role-password'
psql -X -v ON_ERROR_STOP=1 \
  -v database_name=autodev_dev \
  -v migrator_role=autodev_migrator \
  -v app_role=autodev_app \
  -f scripts/bootstrap_postgres.sql postgres
unset AUTODEV_MIGRATOR_PASSWORD AUTODEV_APP_PASSWORD
```

The migration role owns the database and may create schema objects. The
runtime role receives database/schema usage plus table DML and sequence
permissions, but no database, role, or schema creation privilege. Re-running
the script rotates both role passwords to the supplied values and repairs
grants on existing objects. Run `autodev database upgrade` with the migration
role URL; normal Harness and Dashboard processes should use the runtime role
URL. The script establishes default privileges before Alembic creates tables,
so later migrations keep the same separation.

The host-level persistence selector shares
`${XDG_CONFIG_HOME:-~/.config}/autodev/host.yaml` with the capacity policy.
The connection URL itself stays in an environment variable and never in YAML:

```yaml
schema_version: 1
persistence:
  mode: file                 # file | shadow | database
  database_url_env: AUTODEV_DATABASE_URL
  artifact_store: local
```

`AUTODEV_PERSISTENCE_MODE` may override the YAML mode for an explicit
operation. Activating `database` always requires
`AUTODEV_PERSISTENCE_MODE=database`; a host YAML value alone is insufficient.
Normal execution also requires the matching receipt produced by
`activate-cutover`, so setting the environment variable cannot bypass the
freeze/digest gate.
Shadow/database modes require an explicit
`postgresql+psycopg://` URL and never fall back to SQLite or file writes.
SQLite is reachable only through the internal test constructor. The schema
foundation is managed with `autodev database upgrade|current|head|check`;
`downgrade` additionally requires `--yes`. These commands establish and
diagnose the optional database layer.

Run history can be staged and checked without changing file authority:

```bash
autodev database import-runs --repo-root /path/to/repo --project-id PROJECT
autodev database reconcile-runs --repo-root /path/to/repo --project-id PROJECT
```

The selected project id must match every imported `run.yaml`. Import is
content-idempotent, and reconcile returns a failing exit code for any snapshot,
event, or artifact metadata drift.

Queue declarations can likewise be staged without switching the configured
YAML QueuePort:

```bash
autodev database import-queue \
  --repo-root /path/to/repo \
  --project-id PROJECT \
  --queue-path /path/to/repo/tasks.yaml
autodev database reconcile-queue \
  --repo-root /path/to/repo \
  --project-id PROJECT \
  --queue-path /path/to/repo/tasks.yaml
```

The importer stores reviewable task declarations and their digest separately
from database-owned runtime state. Re-importing a changed declaration preserves
status, lease, revision, fencing token, notes, and failure/review gates.
Removing a non-terminal manifest task fails loudly. Database QueuePort
activation is a separate frozen cutover gate; these commands do not mutate the
YAML queue.

The combined shadow and cutover workflow is:

```bash
autodev database shadow-sync \
  --repo-root /path/to/repo --project-id PROJECT --queue-path /path/to/tasks.yaml

# After stopping writers and creating the configured repo-local STOP file:
autodev database prepare-cutover \
  --repo-root /path/to/repo --project-id PROJECT --queue-path /path/to/tasks.yaml

AUTODEV_PERSISTENCE_MODE=database autodev database activate-cutover \
  --repo-root /path/to/repo --project-id PROJECT --queue-path /path/to/tasks.yaml \
  --confirm-digest SHA256_FROM_PREPARE
```

`prepare-cutover` refuses a missing STOP marker, any file/database
`in_progress` task, task-set drift, or a Run/Queue digest mismatch. Activation
recomputes all evidence before atomically updating the host-local receipt; a
stale confirmation digest cannot activate. Once that receipt exists, selecting
`shadow` or `file` fails closed. No automated reverse migration exists, so the
tool never treats compatibility projections as a safe database-to-file
rollback.

Receipt schema v2 authorizes multiple projects against one immutable database
identity. Project additions are append-only under a cross-process lock:
replaying the same project/evidence is idempotent, while reusing a project id
for another repository—or a repository path for another id—fails closed.
Existing v1 single-project receipts remain readable and upgrade to v2 on the
next successful activation. V2 protects the complete receipt—including its
database identity—with an integrity digest. PostgreSQL's omitted port and
explicit default `5432` are treated as the same identity, while legacy v1
fingerprints produced before that normalization remain accepted only for this
default-port equivalence.

To onboard another Git project after this host is already in database mode:

```bash
autodev init \
  --repo /path/to/new-project \
  --project-id new-project \
  --name "New Project" \
  --register

# Review .autodev/project.yaml and the generated queue, commit them, stop this
# project's writers, then create the configured repo-local STOP file.
AUTODEV_PERSISTENCE_MODE=database autodev database prepare-cutover \
  --repo-root /path/to/new-project \
  --project-id new-project \
  --queue-path /path/to/new-project/tasks/agent_task_queue.yaml

AUTODEV_PERSISTENCE_MODE=database autodev database activate-cutover \
  --repo-root /path/to/new-project \
  --project-id new-project \
  --queue-path /path/to/new-project/tasks/agent_task_queue.yaml \
  --confirm-digest SHA256_FROM_PREPARE

autodev database --json cutover-status
```

Use the queue path printed/generated by `autodev init` if it differs from the
illustrative path above. Empty Run history and an empty task list are valid:
prepare still creates and reconciles the project manifest before activation.
The read-only database Dashboard filters its project list through the active
receipt, so a prepared-but-not-activated project is not displayed and every
successfully activated project appears automatically. Existing authorized
projects may continue running during another project's onboarding; runtime
lease and capacity preflight is project-scoped once an active receipt exists.
The first host cutover remains host-scoped and requires all runtime activity to
be drained.

The read-only Dashboard follows the host persistence mode. In `file` and
`shadow`, file state remains authoritative. In explicit `database` mode, the
Dashboard verifies database connectivity and migration head, then reads
multi-project Queue, Run, event, Worker/capacity, and pending landing state
only from PostgreSQL. A database or schema failure is returned as an error; the
Dashboard never scans legacy files and presents them as a healthy fallback.
Recent and explicitly selected Runs rebuild their read-only pipeline from the
latest bounded database event window; an empty attempt/child history is shown
separately and links back to the selected Run's stage detail.
The Runs view keeps up to the latest 256 logical Runs and paginates them eight
per page. Page-number and previous/next links preserve the active status
filter, while database mode loads full event windows only for the visible page.
The execution composition root uses the same explicit mode: Queue, Run/Event,
Landing recovery, supervisor/run heartbeats, and host capacity become
database-owned together. Local Run files remain best-effort compatibility
projections, never a fallback authority.

Commands that need a project config resolve it in this order:

1. explicit `--project PATH`;
2. `AUTODEV_CONFIG`;
3. `.autodev/project.yaml` discovered by walking upward from the current
   directory (so commands work inside a scaffolded repository — note this
   means running `autodev` inside someone else's repository picks up that
   repository's config and policy);
4. `${XDG_CONFIG_HOME:-~/.config}/autodev/project.yaml`.

The default configuration template is packaged inside the wheel and read with
`importlib.resources`; installed commands do not depend on this source checkout.

The multi-project registry lives at
`${XDG_CONFIG_HOME:-~/.config}/autodev/projects.yaml`. `--registry` overrides
that location. A repository-local `config/autodev.projects.yaml` is read only
as a warned compatibility fallback; migrate it once with
`autodev registry migrate --legacy PATH`.

Direction governance is explicit: `generic` reads the packaged reviewer
profile, `project_docs` requires every configured `reference_docs` file to be
readable when configuration loads, and `disabled` records a warning-level
audit event whenever a direction check is triggered.

Notifications default to `dry_run`. Real Feishu and DingTalk delivery uses
separate package-owned provider adapters and provider-specific environment
variable names such as `feishu_webhook_env`; inline webhook, URL, token, or
secret values are rejected. If every provider fails, AutoDev records a failed
event and keeps the rendered message as a local preview artifact.

Agent permissions are declared under `agent.commands.<name>.permissions` and
translated into the final Claude/Codex argv. Claude builders receive the
package hard-deny set plus minimal allowed tools; Codex builders/checkers use
`workspace-write`/`read-only` sandboxes. Role promotion, session-resume flags,
unknown kinds, and non-fresh agents under a fresh-session policy fail loudly
when supplied by project config. Same-task builder resume is instead injected
by the typed Harness adapter after it validates the source run, task, builder
identity, and prior process health.
Normal `autodev doctor` performs static executable/config checks only. An
explicit `doctor --probe-agent NAME --yes` runs the quota-consuming dynamic
probe in a temporary Git repository.

`autodev init --repo PATH` creates a safe, idempotent scaffold: current
Terra/Sol/Fable agent roles, an empty queue, governance starter, AGENTS pointer,
gitignore suggestions, and an inactive Claude settings example. Existing files
are skipped. Global registry mutation happens only with explicit `--register`.

## Build a wheel

```bash
python scripts/build_release.py
```

Dogfood and consumer validation install a versioned wheel rather than relying
on an editable checkout. The release helper
builds in a temporary directory and never deletes or overwrites an existing
wheel. Repeating an identical build is idempotent; different bytes under the
same version fail loudly and require a version bump.

## Safety boundary

The top-level `autodev` command only runs the explicitly selected subcommand;
help, version, status, doctor, and queue reads do not start agents. Execution
entry points retain the existing safety defaults: push is configuration-gated,
notifications default to disabled/dry-run, external-write policy is checked
before any delivery, and no launchd state is changed automatically. Real
notifications send a structured lifecycle envelope only; arbitrary agent text
stays in a redacted local preview. Each run-loop owns a project-scoped lease,
and every task uses a unique worktree/run branch before a CAS update advances
the integration branch.

## v1 compatibility notes

- Queue, config, and run YAML documents without `schema_version` are read as
  schema v1 for compatibility and emit `SchemaMigrationWarning`. AutoDev-managed
  writers always persist `schema_version: 1`.
- Every queue/config/run writer emits schema v1. An explicitly declared
  non-v1 version is rejected before reading or writing back the document.
- Task `verify` values, when present, must be lists of non-empty strings.
  Malformed command shapes are rejected before a task can be claimed; legacy
  descriptive fields retain their v1-compatible shapes.
- The adapter deliberately fails closed when `tasks` is not a list
  or a task entry is not a mapping. The legacy implementation would fail only
  later and less clearly on those malformed inputs. Valid v1 queues remain
  readable; claims now add optional `owner`, `lease_token`, and `revision`
  fields. Automated finalize operations require those values as a CAS. A
  tokenless historical `in_progress` task requires an explicit manual queue
  reconcile instead of being silently reclaimed.
