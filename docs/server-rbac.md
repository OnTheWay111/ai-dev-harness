# Server-side RBAC contract

P3-02 makes authorization a server concern. The authenticated OIDC principal's
opaque `actorId` is matched against active `RoleBinding` records; callers never
supply or override their effective roles. Missing, revoked, cross-Organization,
and cross-Project bindings are denied by default.

## Permission matrix

| Permission | Owner | Project Admin | Approver | Operator | Viewer |
|---|:---:|:---:|:---:|:---:|:---:|
| `organization.manage` | yes | no | no | no | no |
| `project.manage` | yes | yes | no | no | no |
| `role_binding.manage` | yes | yes | no | no | no |
| `goal.read` | yes | yes | yes | yes | yes |
| `goal.write` | yes | yes | yes | no | no |
| `goal.approve` | yes | no | yes | no | no |
| `spec.read` | yes | yes | yes | yes | yes |
| `spec.generate` | yes | yes | yes | no | no |
| `spec.approve` | yes | no | yes | no | no |
| `issue.approve` | yes | no | yes | no | no |
| `run.operate` | yes | yes | no | yes | no |
| `evidence.read` | yes | yes | yes | yes | yes |

An Organization-scoped binding applies to projects inside that Organization.
A Project-scoped binding applies only to that exact Project. Organization Owner
must be Organization-scoped; Project Admin must be Project-scoped.

## Delegation

- Organization Owner may assign all roles, subject to each role's valid scope.
- Project Admin may assign only Approver, Operator, and Viewer inside the exact
  Project where the admin binding is active.
- Project Admin cannot create another Project Admin, create an Owner, assign an
  Organization-wide role, or cross a Project boundary.
- There is no implicit role and no email/domain-based authorization fallback.
  The initial Owner is a controlled bootstrap performed by an operator/migrator
  and must carry its own reason and request ID.

`PolicyEvaluator` is the server module used by Application Services. Frontend
`action.available` values are projections of its result and never substitute
for a policy check at the write boundary.

## Audit and concurrency

`RoleBindingApplicationService` authorizes before mutation. Assignment writes
the binding at version 1 and an immutable `role_binding.assigned` AuditEvent in
one transaction. Revocation performs an optimistic version update and appends
`role_binding.revoked` in the same transaction. A duplicate active binding,
stale revocation, invalid scope, or missing authority fails without an Audit
event that claims success.

The policy matrix and delegation rules run against the in-memory adapter. A
real PostgreSQL integration test executes assignment, policy evaluation,
revocation, and Audit verification against the committed migration.
