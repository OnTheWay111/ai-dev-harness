import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpWorkbenchApi,
  WorkbenchApiError,
} from "../app/workbench/workbench-api.ts";

const responseBody = {
  data: {
    schemaVersion: "workbench.v1",
    revision: 21,
    generatedAt: "2026-08-03T14:32:00+08:00",
    summary: {
      metrics: [],
      taskCounts: {
        all: 0,
        attention: 0,
        running: 0,
        review: 0,
        blocked: 0,
        waiting: 0,
      },
    },
    tasks: [],
  },
  page: { nextCursor: null, total: 0 },
  requestId: "req_test",
};

test("WorkbenchApi reuses its cached response when the server returns 304", async () => {
  const requests = [];
  const fetcher = async (input, init) => {
    requests.push({ input, init });
    if (requests.length === 1) {
      return Response.json(responseBody, {
        headers: { etag: '"workbench-21-test"' },
      });
    }
    return new Response(null, { status: 304 });
  };
  const api = new HttpWorkbenchApi(fetcher);

  const first = await api.getWorkbench({ limit: 50 });
  const second = await api.getWorkbench({ limit: 50 });

  assert.equal(second, first);
  assert.equal(requests[0].input, "/api/v1/workbench?limit=50");
  assert.equal(
    new Headers(requests[1].init.headers).get("if-none-match"),
    '"workbench-21-test"',
  );
});

test("WorkbenchApi exposes the structured server error", async () => {
  const envelope = {
    error: {
      code: "validation_failed",
      message: "limit 无效",
      impact: "工作台数据未加载",
      preservedState: "当前页面数据保持不变",
    },
    requestId: "req_invalid",
  };
  const api = new HttpWorkbenchApi(async () =>
    Response.json(envelope, { status: 400 }),
  );

  await assert.rejects(
    () => api.getWorkbench({ limit: 0 }),
    (error) => {
      assert.ok(error instanceof WorkbenchApiError);
      assert.equal(error.status, 400);
      assert.equal(error.envelope.requestId, "req_invalid");
      return true;
    },
  );
});
