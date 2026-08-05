import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release center UI exposes Canary timeline, gates, and OIDC signatures", async () => {
  const [page, component, client, shell] = await Promise.all([
    readFile(new URL("../app/releases/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/release-center/release-center-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/release-center/api-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/workbench/components/app-shell.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /ReleaseCenterApp/);
  assert.match(component, /P12 发布中心/);
  assert.match(component, /12 小时连续观测/);
  assert.match(component, /Production Gate/);
  assert.match(component, /OIDC/);
  assert.match(component, /负责人签署/);
  assert.match(component, /1\/1 负责人签署/);
  assert.match(component, /Canary 事件时间线/);
  assert.match(component, /resolve-alert/);
  assert.match(client, /\/api\/v1\/releases\/canaries/);
  assert.match(client, /\/api\/v1\/releases\/production/);
  assert.match(shell, /href="\/releases"/);
});
