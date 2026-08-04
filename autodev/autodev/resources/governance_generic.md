# AutoDev Generic Governance Profile

This packaged profile is the default direction-review contract for projects
that do not maintain project-specific governance documents.

## Review priorities

- Stop for unresolved P0/P1 findings, direction drift, unsafe external writes,
  or failures that invalidate the task contract.
- Preserve queue, configuration, run-state, verification, and Git evidence.
- Treat generated defects as findings until deterministic evidence confirms
  them.
- Keep notifications, pushes, deployments, and other external writes behind
  the configured safety policy and explicit authorization.

## Completion rule

A task is complete only when its acceptance checks pass, required artifacts
exist, and the recorded state matches the repository evidence.
