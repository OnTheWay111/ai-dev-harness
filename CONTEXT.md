# AI Dev Harness Control Plane

The control plane turns an internal engineering objective into governed,
traceable work across registered source repositories. Its authoritative
language is separate from the workbench projection used to render operations.

## Language

**Organization**:
The ownership and authorization boundary containing all control-plane work.
_Avoid_: Tenant, account

**Project**:
An organization-owned delivery boundary that groups repositories and goals.
_Avoid_: Workspace

**Repository**:
A project-scoped registration of a remote source repository that work may target.
_Avoid_: Checkout, worktree

**Goal**:
The authoritative contract stating a problem and its desired outcome for one project.
_Avoid_: Task, ticket

**Acceptance Criterion**:
An ordered, independently versioned statement used to judge whether a Goal is satisfied.
_Avoid_: Checklist item, test case

**Workbench Projection**:
A derived operational view of Goals and later execution entities; it is never a business fact source.
_Avoid_: Task table, control-plane state

**Organization Boundary**:
The invariant that every project-owned entity and relationship remains inside one Organization.
_Avoid_: Scope ID
