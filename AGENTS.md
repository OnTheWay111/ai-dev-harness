# AI Dev Harness repository rules

These rules apply to the entire repository rooted at
`/Users/onthewayli/harness/ai-dev-harness`.

## Single-repository policy

- This project uses exactly one Git repository. `prototype/web-ui` is a normal
  directory owned by the root repository, not a submodule or independent
  repository.
- Never create or retain a nested `.git` directory or `.git` file anywhere
  below the repository root. Do not run `git init`, `git clone`, or `git
  worktree add` with a destination inside this repository.
- Clone or inspect third-party repositories in a sibling directory or a
  temporary directory outside this repository.
- Run `node scripts/check-single-git-repository.mjs` after changing repository
  layout. The Web UI test suite also enforces this rule.

## Git delivery

- Every Git command must target the absolute repository path explicitly:
  `git -C /Users/onthewayli/harness/ai-dev-harness ...`.
- The implementation code, `prototype/web-ui`, root files, and `docs/` are all
  committed through the root repository's `main` branch.
- Push only with
  `git -C /Users/onthewayli/harness/ai-dev-harness push origin HEAD:main`, then
  fetch `origin main` and verify that local `HEAD` equals `origin/main`.
- Preserve unrelated user changes. Stage only files that belong to the current
  delivery; never add nested repository metadata.

## Secret safety

- Never commit credentials, populated environment files, PostgreSQL URLs,
  tokens, or private keys.
- Secrets must be injected into server-side child processes at runtime. Never
  expose them through client variables, build arguments, command arguments, or
  logs.
