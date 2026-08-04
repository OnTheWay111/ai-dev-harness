import assert from "node:assert/strict";
import test from "node:test";

async function createWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

async function requestWorkbench(path = "/api/v1/workbench", headers = {}) {
  const worker = await createWorker();
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("returns the V1 workbench snapshot and cache metadata", async () => {
  const response = await requestWorkbench();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.equal(response.headers.get("cache-control"), "private, no-cache");
  assert.equal(response.headers.get("x-workbench-source"), "demo");
  assert.match(response.headers.get("etag") ?? "", /^"workbench-21-/);

  const body = await response.json();
  assert.equal(body.data.schemaVersion, "workbench.v1");
  assert.equal(body.data.revision, 21);
  assert.equal(body.data.tasks.length, 7);
  assert.deepEqual(body.data.summary.taskCounts, {
    all: 7,
    attention: 4,
    running: 1,
    review: 1,
    blocked: 2,
    waiting: 3,
  });
  assert.equal(body.page.total, 7);
  assert.equal(body.page.nextCursor, null);
  assert.match(body.requestId, /^req_/);
});

test("filters and paginates tasks without changing summary scope", async () => {
  const firstResponse = await requestWorkbench(
    "/api/v1/workbench?filter=attention&limit=2",
  );
  assert.equal(firstResponse.status, 200);
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.data.tasks.length, 2);
  assert.equal(firstBody.page.total, 4);
  assert.ok(firstBody.page.nextCursor);
  assert.ok(firstBody.data.tasks.every((task) => task.attention.required));
  assert.equal(firstBody.data.summary.metrics.length, 6);

  const secondResponse = await requestWorkbench(
    `/api/v1/workbench?filter=attention&limit=2&cursor=${encodeURIComponent(firstBody.page.nextCursor)}`,
  );
  assert.equal(secondResponse.status, 200);
  const secondBody = await secondResponse.json();
  assert.equal(secondBody.data.tasks.length, 2);
  assert.equal(secondBody.page.total, 4);
  assert.equal(secondBody.page.nextCursor, null);
  assert.notDeepEqual(
    secondBody.data.tasks.map((task) => task.id),
    firstBody.data.tasks.map((task) => task.id),
  );
});

test("returns 304 for a matching ETag and a structured validation error", async () => {
  const initialResponse = await requestWorkbench("/api/v1/workbench?goalId=GOAL-2407");
  const etag = initialResponse.headers.get("etag");
  assert.ok(etag);

  const notModified = await requestWorkbench(
    "/api/v1/workbench?goalId=GOAL-2407",
    { "if-none-match": etag },
  );
  assert.equal(notModified.status, 304);

  const invalid = await requestWorkbench("/api/v1/workbench?filter=unknown");
  assert.equal(invalid.status, 400);
  const error = await invalid.json();
  assert.equal(error.error.code, "validation_failed");
  assert.equal(error.error.impact, "工作台数据未加载");
  assert.match(error.requestId, /^req_/);
});
