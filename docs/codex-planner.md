# Codex Planner adapter

The P4 Planner is a read-only draft generator behind `PlannerPort`. It cannot
approve a Goal, change authoritative state, or scan a Project repository.

## Isolation contract

Every call builds a `goal-context.v1` packet containing only the Goal ID and
version, title, problem/outcome, ordered acceptance statements, non-goals, and
constraints. Organization, Project, actor, RoleBinding, repository, credentials,
and unrelated documents are excluded.

`CodexPlannerAdapter` then:

1. creates a fresh empty directory below the operating-system temporary root;
2. writes only the caller-provided output JSON Schema;
3. starts `codex exec` with `--ephemeral`, `--sandbox read-only`,
   `--ignore-user-config`, `--ignore-rules`, and `--skip-git-repo-check`;
4. sends the context through standard input, never through command arguments;
5. passes only an allowlist of runtime-path, auth-home, proxy, and CA variables;
6. enforces context, process-output, and wall-clock budgets; and
7. deletes the temporary directory after success or failure.

The subprocess receives no application database URL, OIDC key, deployment
Secret, or browser state. Logs contain only a generated run ID, duration, exit
code, timeout flag, and byte counts. Prompt text, model output, stdout, stderr,
environment values, and temporary paths are not logged.

## Failure behavior

Timeout, non-zero exit, excessive output/context, missing output, and invalid
JSON become stable diagnostic codes. The public error message never embeds the
subprocess output. The adapter returns `status: draft` and the exact source Goal
version; later application services must validate the draft and require any
applicable human decision.

## Verification

`npm run test:planner` runs the fake adapter and subprocess contract tests. The
opt-in command below invokes the installed real Codex CLI once in the same
read-only, ephemeral boundary:

```bash
RUN_CODEX_PLANNER_SMOKE=1 npm run test:planner:smoke
```

The smoke fixture contains no repository content or credentials and asserts
only the schema-shaped result. CI keeps it opt-in because it requires an
authenticated Codex runtime; fake and process-contract tests remain mandatory.

On 2026-08-04 the controlled smoke completed successfully with installed
`codex-cli 0.144.6`. The receipt records only the CLI version and pass/fail
result; model text, authentication material, and local paths were not retained.
