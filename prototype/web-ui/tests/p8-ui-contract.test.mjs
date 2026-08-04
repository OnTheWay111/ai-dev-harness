import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  presentWorkbenchFailure,
} from "../app/workbench/workbench-ui-state.ts";

test("maps permission, conflict, and database failures to actionable retained-state copy", () => {
  const permission = presentWorkbenchFailure(403, {
    error: {
      code: "forbidden",
      message: "当前账号无权执行此操作",
      impact: "本次操作未提交",
      preservedState: "任务和理由草稿仍保留",
      nextAction: "联系管理员分配 Approver",
    },
    requestId: "req-403",
  });
  assert.equal(permission.title, "无权限");
  assert.match(permission.body, /未提交/);
  assert.match(permission.body, /仍保留/);
  assert.match(permission.body, /Approver/);

  assert.equal(presentWorkbenchFailure(409, {
    error: { code: "version_conflict", message: "任务已更新", impact: "决定未提交", preservedState: "理由仍保留", nextAction: "刷新后重试" },
    requestId: "req-409",
  }).title, "状态冲突");
  assert.equal(presentWorkbenchFailure(500, {
    error: { code: "internal_error", message: "数据库不可用", impact: "刷新失败", preservedState: "保留上次数据", nextAction: "稍后重试" },
    requestId: "req-500",
  }).title, "服务暂时不可用");
});

test("workbench UI exposes loading, retained refresh, empty, receipt, dialog, and accessible feedback states", async () => {
  const root = new URL("../app/workbench/components/", import.meta.url);
  const [app, overview, actionDialog, page, css] = await Promise.all([
    readFile(new URL("workbench-app.tsx", root), "utf8"),
    readFile(new URL("overview-view.tsx", root), "utf8"),
    readFile(new URL("task-action-dialog.tsx", root), "utf8"),
    readFile(new URL("../../page.tsx", root), "utf8"),
    readFile(new URL("../../globals.css", root), "utf8"),
  ]);
  assert.match(app, /aria-busy/);
  assert.match(app, /保留上次成功数据|保留.*数据/);
  assert.match(overview, /真实数据为空|暂无可见任务/);
  assert.match(actionDialog, /role="dialog"/);
  assert.match(actionDialog, /aria-modal="true"/);
  assert.match(actionDialog, /aria-live="polite"/);
  assert.match(actionDialog, /处理中|已接受/);
  assert.match(actionDialog, /disabled=/);
  assert.match(page, /page-failure-state/);
  assert.match(page, /role="alert"/);
  assert.match(page, /没有展示过期数据或演示数据/);
  assert.match(css, /\.workbench-state-banner/);
  assert.match(css, /\.task-action-dialog/);
});
