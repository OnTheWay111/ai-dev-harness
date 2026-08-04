import assert from "node:assert/strict";
import test from "node:test";

import {
  RoleBindingVisibilityResolver,
  visibilityScopeKey,
} from "../app/auth/visibility-scope.ts";
import { handleWorkbenchRequest } from
  "../app/api/v1/workbench/route.ts";

const organizationA = "10000000-0000-4000-8000-000000000001";
const organizationB = "10000000-0000-4000-8000-000000000002";
const projectB = "20000000-0000-4000-8000-000000000002";

test("derives the actor visibility only from active server role bindings", async () => {
  const resolver = new RoleBindingVisibilityResolver({
    async listActorActive(actorId) {
      assert.equal(actorId, "actor-1");
      return [
        {
          id: "binding-owner",
          organizationId: organizationA,
          projectId: null,
          actorId,
          role: "organization_owner",
          version: 1,
          createdAt: "2026-08-04T00:00:00.000Z",
          revokedAt: null,
        },
        {
          id: "binding-viewer",
          organizationId: organizationB,
          projectId: projectB,
          actorId,
          role: "viewer",
          version: 1,
          createdAt: "2026-08-04T00:00:00.000Z",
          revokedAt: null,
        },
      ];
    },
  });

  const visibility = await resolver.resolve("actor-1");
  assert.deepEqual(visibility, {
    actorId: "actor-1",
    organizationIds: [organizationA],
    projectIds: [projectB],
  });
  assert.equal(visibilityScopeKey(visibility), visibilityScopeKey({
    actorId: "actor-1",
    organizationIds: [organizationA],
    projectIds: [projectB],
  }));
});

function repository(revision = 7) {
  return {
    kind: "postgres",
    async getWorkbench(visibility) {
      return {
        data: {
          schemaVersion: "workbench.v1",
          revision,
          generatedAt: "2026-08-04T00:00:00.000Z",
          summary: { metrics: [], taskCounts: {
            all: 0,
            attention: 0,
            running: 0,
            review: 0,
            blocked: 0,
            waiting: 0,
          } },
          tasks: [],
        },
        page: { nextCursor: null, total: 0 },
        cacheTag: `revision:${revision}`,
        observedVisibility: visibility,
      };
    },
  };
}

test("API gets visibility from a trusted resolver and scopes ETags", async () => {
  const firstVisibility = {
    actorId: "actor-1",
    organizationIds: [organizationA],
    projectIds: [],
  };
  const secondVisibility = {
    actorId: "actor-2",
    organizationIds: [],
    projectIds: [projectB],
  };
  const first = await handleWorkbenchRequest(
    new Request("http://localhost/api/v1/workbench"),
    () => repository(),
    async () => firstVisibility,
  );
  const second = await handleWorkbenchRequest(
    new Request("http://localhost/api/v1/workbench"),
    () => repository(),
    async () => secondVisibility,
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.headers.get("etag"), second.headers.get("etag"));
  assert.doesNotMatch(await first.text(), /observedVisibility|actor-1/);
});

test("API fails before repository access without an authorized scope", async () => {
  let repositoryCalls = 0;
  const repositoryProvider = () => {
    repositoryCalls += 1;
    return repository();
  };
  const unauthenticated = await handleWorkbenchRequest(
    new Request("http://localhost/api/v1/workbench"),
    repositoryProvider,
    async () => null,
  );
  const unassigned = await handleWorkbenchRequest(
    new Request("http://localhost/api/v1/workbench"),
    repositoryProvider,
    async () => ({
      actorId: "actor-unassigned",
      organizationIds: [],
      projectIds: [],
    }),
  );

  assert.equal(unauthenticated.status, 401);
  assert.equal(unassigned.status, 403);
  assert.equal(repositoryCalls, 0);
});

test("organization and project query parameters cannot expand visibility", async () => {
  let observed;
  const trusted = {
    actorId: "actor-1",
    organizationIds: [organizationA],
    projectIds: [],
  };
  const response = await handleWorkbenchRequest(
    new Request(
      `http://localhost/api/v1/workbench?organizationId=${organizationB}` +
        `&projectId=${projectB}`,
    ),
    () => ({
      kind: "postgres",
      async getWorkbench(visibility) {
        observed = visibility;
        return repository().getWorkbench(visibility);
      },
    }),
    async () => trusted,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(observed, trusted);
});
