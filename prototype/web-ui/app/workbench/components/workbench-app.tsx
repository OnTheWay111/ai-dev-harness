"use client";

import { useCallback, useEffect, useState } from "react";

import type { View, WorkbenchSnapshot } from "../contracts";
import { WorkbenchApiError, workbenchApi } from "../workbench-api";
import type { GoalWorkspaceScope } from "../goal-workspace-api";
import { Sidebar, Topbar } from "./app-shell";
import { ClarifyView } from "./clarify-view";
import { IssuesView, type IssuePlanContext } from "./issues-view";
import { OverviewView } from "./overview-view";
import { RunCenterView } from "./run-center-view";
import { SchedulerView } from "./scheduler-view";
import { VerifyView } from "./verify-view";

export function WorkbenchApp({
  initialSnapshot,
  goalWorkspaceScope,
}: {
  initialSnapshot: WorkbenchSnapshot;
  goalWorkspaceScope: GoalWorkspaceScope;
}) {
  const [view, setView] = useState<View>("overview");
  const [toast, setToast] = useState("");
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [issuePlanContext, setIssuePlanContext] = useState<IssuePlanContext | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [view]);

  useEffect(() => {
    let active = true;
    workbenchApi
      .getWorkbench({ limit: 50 })
      .then((response) => {
        if (active) setSnapshot(response.data);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const detail =
          error instanceof WorkbenchApiError
            ? error.envelope.error.preservedState
            : "当前页面仍保留服务端首屏数据";
        notify(`数据刷新失败；${detail}`);
      });
    return () => {
      active = false;
    };
  }, [notify]);

  return (
    <div className="app-shell">
      <Sidebar current={view} onChange={setView} />
      <div className="app-main">
        <Topbar view={view} onCreateGoal={() => setView("clarify")} />
        {view === "overview" && (
          <OverviewView snapshot={snapshot} onNavigate={setView} notify={notify} />
        )}
        {view === "scheduler" && <SchedulerView notify={notify} />}
        {view === "clarify" && (
          <ClarifyView
            scope={goalWorkspaceScope}
            onContinue={(context) => {
              setIssuePlanContext(context);
              notify("已批准规格已锁定，正在生成 Issue 开发合同");
              setView("issues");
            }}
            notify={notify}
          />
        )}
        {view === "issues" && (
          <IssuesView
            scope={goalWorkspaceScope}
            context={issuePlanContext}
            onApprove={() => setView("run")}
            notify={notify}
          />
        )}
        {view === "run" && <RunCenterView onVerify={() => setView("verify")} notify={notify} />}
        {view === "verify" && <VerifyView notify={notify} />}
      </div>
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span>✓</span>{toast}
        </div>
      )}
    </div>
  );
}
