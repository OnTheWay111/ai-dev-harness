# AutoDev 0.4.16 execution compatibility

> Verification date: 2026-08-04
>
> Verified source: root repository `autodev/`
>
> Result: **P7-01 compatibility gate passed for repository-scoped use**

## Version and authorization boundary

The execution adapter is pinned to `autodev 0.4.16`. The package declares
`LicenseRef-Proprietary`; the repository evaluation records this source bundle
as the authorized local AutoDev implementation. This gate authorizes use and
modification inside this repository and its controlled deployments only. It
does not infer redistribution, relicensing, SaaS resale, or use of a different
AutoDev source bundle. Any broader use requires an explicit rights review.

The scheduler fails closed if the versioned command/event contract or the
required network enforcement boundary is absent. It never edits AutoDev Queue
YAML or patches installed AutoDev source at runtime.

## Verified production seams

The isolated smoke fixture verifies these real 0.4.16 seams:

- authenticated atomic `POST /api/v1/queue/import` and durable replay receipt;
- imported `capabilityTier` retained as task-level `preferred_builder`;
- configured builder-catalog selection with no silent fallback;
- `run-one --project ... --task ... --run-id ... --json`;
- `status --project ... --run-id ... --json`;
- append-only `autodev.run-event.v1` JSONL events with unique `event_id` and
  contiguous `sequence`;
- exact approved prompt, verification commands, dependencies, expected files,
  evidence contract, Wave, capability, and reasoning effort.

AutoDev project configuration must provide writable builder aliases for the
four control-plane capability tiers (`cost_optimized`, `general_coding`,
`advanced_coding`, and `frontier`). A missing or read-only alias is a hard
compatibility failure. Concrete commands/models stay in server-side AutoDev
configuration and are not persisted in an approved Issue Plan.

## Automated evidence

The following suites are the gate:

```bash
python -m unittest discover -s autodev/tests -v
cd prototype/web-ui
npm run test:p7
npm run test:autodev:integration
npm run test:postgres:integration
```

The Python suite covers atomic import, database rollback/recovery, authenticated
HTTP, task-level Builder preservation, prompt propagation, and event identity.
The real smoke initializes an isolated Git repository outside the product
repository, imports a two-task plan, selects the configured preferred Builder,
runs an AutoDev dry run, reads the real event journal, and reads status through
the machine API. Fake and real smoke results are checked by the same execution
contract assertion.

## Operational restrictions

- The Execution Gateway only launches fixed argument arrays with `shell:false`.
- A configured network wrapper is mandatory. Lack of an enforceable wrapper is
  a launch failure, not a warning.
- Child environments contain only a small process allowlist and explicitly
  selected Secret names. Output is bounded and redacted before persistence.
- Every invocation uses a temporary working directory; cleanup failure is an
  execution failure. AutoDev's policy must additionally require isolated Git
  Worktrees for code mutation.
- The current 0.4.16 integration has no remote event webhook. The scheduler
  reads the bounded local JSONL journal and delivers it through the durable
  Inbox. Deployments must colocate the scheduler with the mounted AutoDev
  repository or provide an equivalent audited event transport.
