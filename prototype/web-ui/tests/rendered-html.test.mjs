import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
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

test("server-renders the Forge production control plane", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Forge · AI Dev Harness<\/title>/i);
  assert.match(html, /AI DEV HARNESS/);
  assert.match(html, /研发工作台/);
  assert.match(html, /运行态势/);
  assert.match(html, /全局任务/);
  assert.match(html, /执行进度/);
  assert.match(html, /待处理问题/);
  assert.match(html, /执行上下文/);
  assert.match(html, /任务正常推进/);
  assert.match(html, /业务优先级 → 截止时间 → 阻塞影响 → 等待时长/);
  assert.match(html, /预算健康/);
  assert.match(html, /全局调度/);
  assert.match(html, /目标与澄清/);
  assert.match(html, /方案与 Issue/);
  assert.match(html, /执行中心/);
  assert.match(html, /目标验收/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("exposes the six critical workflow destinations", async () => {
  const response = await render();
  const html = await response.text();

  for (const destination of [
    "工作台",
    "全局调度",
    "目标与澄清",
    "方案与 Issue",
    "执行中心",
    "目标验收",
  ]) {
    assert.match(html, new RegExp(destination));
  }
});
