# AutoDev 0.4.16 queue import compatibility

> Verification date: 2026-08-04
>
> Verified source: `/Users/onthewayli/harness/autodev-harness-0.4.16`
>
> Result: **P6-06 compatibility gate passed**

## Formal import boundary

The authorized AutoDev 0.4.16 source now exposes a dedicated server command:

```text
autodev queue-import-server --project <config> --host 127.0.0.1 --port 8766
POST /api/v1/queue/import
GET  /healthz
```

The import endpoint accepts exactly one `autodev-queue-import.v1` document,
requires `atomic: true`, an `Idempotency-Key`, an `X-Request-Id`, JSON content,
and a bearer token from `AUTODEV_QUEUE_IMPORT_TOKEN`. The token has no command
argument, YAML field, response field, or request-log path. The service binds to
loopback by default, caps request bodies at 1 MiB, uses constant-time bearer
comparison, returns sanitized errors, and disables request logging.

The request carries the approved plan ID/digest and, per Issue, the title,
goal, self-contained development prompt, acceptance contract, verification
commands, completion evidence, dependency keys, expected files, execution
wave, capability tier, reasoning effort, and routing policy revision. AutoDev
rejects unknown/missing fields, unsupported routes, duplicate/unknown/self
dependencies, cycles, invalid dependency waves, weak prompts, incomplete
evidence, and non-atomic requests before persistence.

## Atomic and idempotent persistence

The YAML backend validates the complete translated Queue candidate while
holding the existing Queue file lock, then writes all tasks and the durable
receipt in one atomic replacement. It never exposes a partially imported plan.
The optional database backend performs task rows, events, and the completed
`ImportBatch` receipt in one unit-of-work transaction; the rollback test proves
that invalid batches leave neither tasks nor receipt rows.

Issue dependencies are translated only after every external `H-*` task ID is
allocated. Imported tasks enter `pending` as approved work and retain the
development prompt, completion evidence, expected files/exclusive resources,
execution wave, and capability route. Builder prompt rendering includes that
approved execution contract verbatim. It does not resolve a concrete model
name; that remains the P7 scheduler responsibility.

Replays by the same idempotency key or by plan identity return the original
deterministic receipt and never add tasks. Every newly observed replay key is
also durably bound, so it cannot later be reused for a different plan. Receipt
replay fails closed if its task mapping no longer matches Queue state. A YAML
to database cutover can reconstruct and persist the same deterministic receipt
from imported task source metadata without duplicating work.

## Verification evidence

AutoDev tests (`python -m unittest discover -s tests -v`) pass 10/10 and cover:

- YAML all-or-nothing import, exact dependency/route/prompt preservation;
- same-key and same-plan replay plus conflicting-key rejection;
- cycle, route, digest, and receipt-corruption failure without partial writes;
- authenticated HTTP success and unauthenticated/malformed failure;
- database commit/rollback and YAML-to-database receipt recovery;
- verbatim Builder prompt propagation.

The control-plane integration command also passes against the real AutoDev
process:

```bash
AUTODEV_SOURCE_PATH=/Users/onthewayli/harness/autodev-harness-0.4.16 \
  npm run test:autodev:integration
```

It scaffolds a temporary AutoDev project, starts the formal HTTP server, proves
an invalid two-Issue batch leaves zero tasks, imports a valid two-Issue plan
through the production `AutoDevQueueImportAdapter`, verifies `H-001/H-002` and
the exact dependency/model-route mapping, and proves replay creates no duplicate
tasks. The temporary project and server are removed afterward.

## Secret injection and rotation

Set `AUTODEV_QUEUE_IMPORT_URL` and `AUTODEV_QUEUE_IMPORT_TOKEN` only in the AI
Dev Harness server environment; set `AUTODEV_QUEUE_IMPORT_TOKEN` in the AutoDev
server environment. Keep the default loopback binding unless a private
TLS-authenticated proxy protects the endpoint. Rotate by stopping the import
server, changing both server-side secret-store values, restarting it, verifying
`/healthz`, and then removing the old value. Never place the token in browser
variables, project YAML, command arguments, logs, or committed environment
files. The existing client artifact secret scan remains green.

The inspected AutoDev directory is a source distribution without Git metadata.
Its authorized working copy is modified and verified, but no nested or new Git
repository was created. The AI Dev Harness integration test and compatibility
record are versioned in the root repository; publishing the AutoDev changes
itself requires the owner's actual AutoDev Git repository.
