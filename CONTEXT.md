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

**Clarification**:
An append-only revision in a Goal-scoped question thread that records an open question or its answered successor.
_Avoid_: Mutable Q&A, chat message

**Decision**:
An append-only, reasoned disposition of a versioned planning subject within one Goal.
_Avoid_: Approval flag, comment

**Spec Revision**:
A versioned, artifact-backed proposal for satisfying a Goal; only an explicitly approved revision can source executable work.
_Avoid_: PRD row, latest spec

**Issue**:
A versioned unit of planned delivery derived from one Spec Revision and bounded by one Goal.
_Avoid_: Task, queue item

**Issue Dependency**:
A directed prerequisite edge between two Issue revisions inside the same Goal.
_Avoid_: Cross-Goal link, ordering hint

**Run**:
One numbered execution attempt for a particular Issue revision.
_Avoid_: Worker, job

**Evidence**:
Immutable metadata identifying an artifact that proves something about a Run; the artifact content lives outside the control-plane database.
_Avoid_: Log blob, mutable attachment

**Audit Event**:
An immutable account of who made a control-plane change, when, why, and against which entity version.
_Avoid_: Application log, history row

**Workbench Projection**:
A derived operational view of Goals and later execution entities; it is never a business fact source.
_Avoid_: Task table, control-plane state

**Organization Boundary**:
The invariant that every project-owned entity and relationship remains inside one Organization.
_Avoid_: Scope ID
