import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkbenchEventsHandler,
  formatWorkbenchInvalidationEvent,
  PollingWorkbenchRevisionFeed,
} from "../app/workbench/server/workbench-events.ts";
import {
  WorkbenchRealtimeClient,
} from "../app/workbench/workbench-realtime.ts";

class FakeEventSource {
  listeners = new Map();
  closed = false;
  onopen = null;
  onerror = null;

  constructor(url) { this.url = url; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  emit(type, data, lastEventId = "") {
    this.listeners.get(type)?.({ data: JSON.stringify(data), lastEventId });
  }
  open() { this.onopen?.(new Event("open")); }
  fail() { this.onerror?.(new Event("error")); }
  close() { this.closed = true; }
}

test("formats revision-only SSE invalidation events with stable IDs", () => {
  const encoded = formatWorkbenchInvalidationEvent({
    revision: 22,
    generatedAt: "2026-08-05T02:00:00.000Z",
  });
  assert.match(encoded, /^id: 22\nevent: workbench\.snapshot\.invalidated\n/);
  assert.match(encoded, /"revision":22/);
  assert.doesNotMatch(encoded, /tasks|summary|secret/i);
});

test("polling feed suppresses old revisions and reports jumps", async () => {
  const revisions = [21, 21, 24];
  const feed = new PollingWorkbenchRevisionFeed({
    read: async () => ({
      revision: revisions.shift() ?? 24,
      generatedAt: "2026-08-05T02:00:00.000Z",
    }),
    wait: async () => {},
  });
  const iterator = feed.events(21, new AbortController().signal)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { revision: 24, generatedAt: "2026-08-05T02:00:00.000Z" },
  });
  await iterator.return();
});

test("SSE handshake returns a sanitized retryable error when revision storage fails", async () => {
  const handler = createWorkbenchEventsHandler({
    async resolveRevision() {
      throw new Error("postgresql://private-user:private-password@db.internal/workbench");
    },
  });
  const response = await handler(new Request("https://harness.invalid/api/v1/workbench/events?afterRevision=21"));
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.match(body, /service_unavailable/);
  assert.match(body, /保留上次成功数据/);
  assert.doesNotMatch(body, /private-user|private-password|db\.internal/);
});

test("client deduplicates revisions, refreshes full snapshots on jumps, reconnects with backoff, and cleans up", async () => {
  const sources = [];
  const timers = [];
  const snapshots = [];
  let getCalls = 0;
  const client = new WorkbenchRealtimeClient({
    api: {
      async getWorkbench() {
        getCalls += 1;
        return {
          data: { schemaVersion: "workbench.v1", revision: getCalls === 1 ? 22 : 24, generatedAt: "2026-08-05T02:00:00.000Z", summary: { metrics: [], taskCounts: {} }, tasks: [] },
          page: { nextCursor: null, total: 0 },
          requestId: "req-live",
        };
      },
    },
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    schedule: (callback, delay) => {
      const token = { callback, delay, cancelled: false };
      timers.push(token);
      return token;
    },
    cancelSchedule: (token) => { token.cancelled = true; },
    onSnapshot: (snapshot) => snapshots.push(snapshot.revision),
  });

  client.start(21);
  assert.match(sources[0].url, /afterRevision=21/);
  sources[0].open();
  sources[0].emit("workbench.snapshot.invalidated", { revision: 22 }, "22");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(snapshots, [22]);
  sources[0].emit("workbench.snapshot.invalidated", { revision: 22 }, "22");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getCalls, 1);

  sources[0].emit("workbench.snapshot.invalidated", { revision: 24 }, "24");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(snapshots, [22, 24]);

  sources[0].fail();
  assert.equal(sources[0].closed, true);
  assert.equal(timers[0].delay, 1_000);
  timers[0].callback();
  assert.match(sources[1].url, /afterRevision=24/);
  sources[1].open();
  client.stop();
  assert.equal(sources[1].closed, true);
  assert.ok(timers.every((timer) => timer.cancelled || timer === timers[0]));
});

test("client retains data and reconnects from its last good revision after a stale cached refresh", async () => {
  const sources = [];
  const timers = [];
  const snapshots = [];
  let calls = 0;
  const client = new WorkbenchRealtimeClient({
    api: {
      async getWorkbench() {
        calls += 1;
        const revision = calls === 1 ? 21 : 22;
        return {
          data: { schemaVersion: "workbench.v1", revision, generatedAt: "2026-08-05T02:00:00.000Z", summary: { metrics: [], taskCounts: {} }, tasks: [] },
          page: { nextCursor: null, total: 0 },
          requestId: "req-stale-cache",
        };
      },
    },
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelSchedule: (timer) => { timer.cancelled = true; },
    onSnapshot: (snapshot) => snapshots.push(snapshot.revision),
  });

  client.start(21);
  sources[0].open();
  sources[0].emit("workbench.snapshot.invalidated", { revision: 22 }, "22");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(snapshots, []);
  assert.equal(sources[0].closed, true);
  assert.equal(timers[0].delay, 1_000);

  timers[0].callback();
  assert.match(sources[1].url, /afterRevision=21/);
  sources[1].open();
  sources[1].emit("workbench.snapshot.invalidated", { revision: 22 }, "22");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(snapshots, [22]);
  client.stop();
});
