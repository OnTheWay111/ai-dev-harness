# AutoDev 0.4.16 queue import compatibility

> Verification date: 2026-08-04
> Inspected installation: `/Users/onthewayli/harness/autodev-harness-0.4.16`
> Result: **P6-06 external compatibility gate is blocked**

## Verified facts

The installed executable reports `autodev 0.4.16`. Running its isolated
environment produced this queue command surface:

```text
summary next claim done block resume propose approve
```

`queue propose --help` accepts title, goal, acceptance, verify, source refs,
priority, area, proposer, and dependencies. It does not expose:

- a batch or plan-level atomic Import operation;
- an idempotency/digest receipt for a complete Issue plan;
- a task-level `preferred_builder`/capability argument.

The same facts are visible in `autodev/queue_cli.py`: the CLI calls
`QueuePort.propose` once per task. `autodev/queue_adapter.py` identifies the
only supported queue type as `task_harness_yaml`; that is an internal adapter,
not a supported control-plane Import API. The package metadata declares
`LicenseRef-Proprietary`, and no written authorization for a task-level Builder
extension is present in this repository.

Using repeated `propose` calls could leave a partial plan when a later task
fails and cannot carry the approved per-Issue model route. Directly changing
the queue persistence would also cross the explicit Production V1 boundary.
Neither is an acceptable implementation of P6-06.

## Implemented failure-closed seam

The control plane now owns a `QueueProjectionPort` and a server-only formal
HTTP Import adapter. Its contract requires one atomic request, plan digest,
idempotency key, exact Issue-to-external-task mapping, and an atomic receipt.
It rejects non-atomic, partial, duplicate, or digest-mismatched responses and
stores no completed projection receipt on failure. The UI reuses a stable
plan-and-digest idempotency key, while the receipt store also deduplicates by
plan digest. The adapter contains no filesystem or process mutation path.

`AUTODEV_QUEUE_IMPORT_URL` and `AUTODEV_QUEUE_IMPORT_TOKEN` are intentionally
empty by default. The token is server-only and the client artifact scanner
rejects its name if it enters browser output. With no supported endpoint, the
API returns `queue_import_unavailable` and leaves the Issue plan approved but
unprojected.

## Gate to unblock P6-06

All of the following are still required:

1. AutoDev provides a supported, authorized atomic Import/API, or written
   authorization permits a validated task-level Builder extension.
2. The interface accepts capability tier/reasoning effort or an equivalent
   supported task route without concrete model names in the Issue.
3. A real AutoDev 0.4.16 compatibility test proves atomic failure, idempotent
   replay, exact dependency mapping, receipt integrity, and zero partial tasks.
4. Environment-scoped endpoint/token injection and rotation are documented and
   validated without exposing the token to command arguments, logs, or client
   artifacts.

Until those conditions pass, P6-06 and the M2 external projection Gate must
remain unchecked.
