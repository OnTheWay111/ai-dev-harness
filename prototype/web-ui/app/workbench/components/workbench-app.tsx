"use client";

import { useCallback, useEffect, useState } from "react";

import type { View, WorkbenchSnapshot } from "../contracts";
import { WorkbenchApiError, workbenchApi } from "../workbench-api";
import { WorkbenchRealtimeClient, type WorkbenchRealtimeState } from
  "../workbench-realtime";
import { presentWorkbenchFailure, type WorkbenchFailurePresentation } from
  "../workbench-ui-state";
import type { GoalWorkspaceScope } from "../goal-workspace-api";
import { goalDraftStorageKey } from "../goal-workspace-draft";
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
  const [realtimeState, setRealtimeState] = useState<WorkbenchRealtimeState>("connecting");
  const [failure, setFailure] = useState<WorkbenchFailurePresentation | null>(null);
  const [issuePlanContext, setIssuePlanContext] = useState<IssuePlanContext | null>(null);
  const [restoredGoalId, setRestoredGoalId] = useState<string | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [view]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setRestoredGoalId(window.localStorage.getItem(
        `${goalDraftStorageKey(goalWorkspaceScope)}:last-goal`,
      ));
    });
    return () => { active = false; };
  }, [goalWorkspaceScope]);

  const refreshWorkbench = useCallback(async () => {
    setRealtimeState("refreshing");
    try {
      const response = await workbenchApi.getWorkbench({ limit: 50 });
      setSnapshot(response.data);
      setFailure(null);
      setRealtimeState("connected");
    } catch (error) {
      if (error instanceof WorkbenchApiError) {
        setFailure(presentWorkbenchFailure(error.status, error.envelope));
      } else {
        setFailure({
          title: "服务暂时不可用",
          body: "本次刷新失败；页面保留上次成功数据；稍后自动重试或手动刷新",
          requestId: "req_unavailable",
        });
      }
      setRealtimeState("connected");
    }
  }, []);

  const downloadArtifact = useCallback(async (artifactId: string) => {
    notify("正在申请最长 5 分钟的授权下载链接");
    try {
      const grant = await workbenchApi.createArtifactDownload(artifactId);
      const anchor = document.createElement("a");
      anchor.href = grant.downloadUrl;
      anchor.rel = "noreferrer";
      anchor.download = "";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      notify("下载授权已创建，链接将在 5 分钟内失效");
    } catch (error) {
      notify(error instanceof WorkbenchApiError
        ? error.envelope.error.message
        : "Artifact 下载授权创建失败");
    }
  }, [notify]);

  useEffect(() => {
    let active = true;
    const realtime = new WorkbenchRealtimeClient({
      api: workbenchApi,
      onSnapshot: (next) => {
        if (!active) return;
        setSnapshot(next);
        setFailure(null);
      },
      onState: (state) => {
        if (active) setRealtimeState(state);
      },
      onError: (error) => {
        if (!active) return;
        if (error instanceof WorkbenchApiError) {
          setFailure(presentWorkbenchFailure(error.status, error.envelope));
        } else {
          setFailure({
            title: "实时刷新暂时中断",
            body: "实时连接正在重连；页面保留上次成功数据；无需重复操作",
            requestId: "req_unavailable",
          });
        }
      },
    });
    void workbenchApi.getWorkbench({ limit: 50 })
      .then((response) => {
        if (!active) return;
        setSnapshot(response.data);
        setFailure(null);
        realtime.start(response.data.revision);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof WorkbenchApiError) {
          setFailure(presentWorkbenchFailure(error.status, error.envelope));
        } else {
          setFailure({
            title: "服务暂时不可用",
            body: "首次刷新失败；页面保留服务端上次成功数据；连接恢复后自动更新",
            requestId: "req_unavailable",
          });
        }
        realtime.start(initialSnapshot.revision);
      });
    return () => {
      active = false;
      realtime.stop();
    };
  }, [initialSnapshot.revision]);

  return (
    <div className="app-shell" aria-busy={realtimeState === "refreshing"}>
      <Sidebar current={view} onChange={setView} />
      <div className="app-main">
        <Topbar view={view} onCreateGoal={() => setView("clarify")} />
        {realtimeState === "refreshing" && (
          <div className="workbench-state-banner refreshing" role="status">
            正在刷新权威状态，保留上次成功数据，操作无需重复提交。
          </div>
        )}
        {realtimeState === "reconnecting" && (
          <div className="workbench-state-banner reconnecting" role="status">
            实时连接已中断，正在重连；当前页面保留上次成功数据。
          </div>
        )}
        {failure && (
          <div className="workbench-state-banner failure" role="alert">
            <strong>{failure.title}</strong>
            <span>{failure.body}</span>
            <small>请求 ID：{failure.requestId}</small>
            <button type="button" onClick={() => void refreshWorkbench()}>重新刷新</button>
          </div>
        )}
        {view === "overview" && (
          <OverviewView
            snapshot={snapshot}
            onNavigate={setView}
            onRefresh={refreshWorkbench}
            notify={notify}
          />
        )}
        {view === "scheduler" && <SchedulerView notify={notify} />}
        {view === "clarify" && (
          <ClarifyView
            scope={goalWorkspaceScope}
            onContinue={(context) => {
              setIssuePlanContext(context);
              setRestoredGoalId(context.goalId);
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
        {view === "run" && (
          <RunCenterView
            onVerify={() => setView("verify")}
            notify={notify}
            tasks={snapshot.tasks}
            onDownloadArtifact={(artifactId) => void downloadArtifact(artifactId)}
          />
        )}
        {view === "verify" && (
          <VerifyView
            notify={notify}
            scope={goalWorkspaceScope}
            goalId={issuePlanContext?.goalId ?? restoredGoalId}
          />
        )}
      </div>
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span>✓</span>{toast}
        </div>
      )}
    </div>
  );
}
