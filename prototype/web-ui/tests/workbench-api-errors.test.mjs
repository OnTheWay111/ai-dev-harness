import assert from "node:assert/strict";
import test from "node:test";

import {
  handleWorkbenchRequest,
} from "../app/api/v1/workbench/route.ts";

test("ordinary API failures stay structured and suppress internal errors", async () => {
  const messages = [];
  const originalError = console.error;
  console.error = (...values) => messages.push(values);
  try {
    const response = await handleWorkbenchRequest(
      new Request("http://localhost/api/v1/workbench"),
      () => {
        throw new Error(
          "connection failed for postgresql://app:do-not-expose@example.test/workbench",
        );
      },
      async () => ({
        actorId: "actor-test",
        organizationIds: ["10000000-0000-4000-8000-000000000001"],
        projectIds: [],
      }),
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, "internal_error");
    assert.equal(body.error.message, "工作台数据暂时不可用");
    assert.match(body.requestId, /^req_/);
    assert.doesNotMatch(JSON.stringify(body), /do-not-expose|postgres(?:ql)?:\/\//i);
    assert.doesNotMatch(
      JSON.stringify(messages),
      /do-not-expose|connection failed|postgres(?:ql)?:\/\//i,
    );
  } finally {
    console.error = originalError;
  }
});
