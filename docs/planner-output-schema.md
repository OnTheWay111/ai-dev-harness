# Planner clarification output schema

`planner-clarification.v1` is the only accepted Planner clarification format.
The model receives this closed JSON Schema through Codex `--output-schema`; the
server validates the returned value again before any application service may
use it.

## Shape

The root object rejects additional fields and requires:

- `schemaVersion`: exactly `planner-clarification.v1`;
- `knownFacts`: stable ID, fact text, and a `goal_contract` or `human_answer`
  basis;
- `uncertainties`: stable ID, unresolved statement, and delivery impact; and
- `questions`: stable ID, prompt, rationale, `blocker | high | medium | low`
  blocking level, suggested answer type, and an explicit options array.

Every nested object also rejects additional fields. Answer types are
`single_choice`, `multiple_choice`, `boolean`, `text`, or `number`. The Codex
schema intentionally uses the Structured Outputs-supported JSON Schema subset.
The server adds deterministic limits for identifier format, text length, item
count, and uniqueness.

## Failure contract

There is no coercion, best-effort parsing, unknown-version fallback, or guessing
of omitted fields. Invalid output raises `planner_schema_invalid` with only
field paths and diagnostic codes. Rejected model content is never copied into
errors or logs.

`ClarificationPlannerService` always supplies the v1 schema to `PlannerPort`
and validates the result before returning a `status: draft` envelope bound to
the source Goal version. A valid draft still has no authority to approve a Goal
or decide a Gate.

## Compatibility and evidence

Committed valid and malformed fixtures cover the current contract. Tests reject
unknown versions, missing fields, invalid enums, and additional root or nested
fields. On 2026-08-04 the same schema passed a controlled real Codex CLI smoke
test in the P4-02 ephemeral read-only adapter.
