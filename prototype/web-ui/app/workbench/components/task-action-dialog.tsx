import { useEffect, useId, useRef, useState } from "react";

import type {
  CommandReceipt,
  GlobalTask,
} from "../contracts.ts";
import { workbenchApi, WorkbenchApiError } from "../workbench-api.ts";
import {
  presentWorkbenchFailure,
  type WorkbenchFailurePresentation,
} from "../workbench-ui-state.ts";

function actionDescription(task: GlobalTask): string {
  if (task.action.id === "review_evidence") return "提交证据评审决定；命令会异步执行。";
  if (task.action.id === "answer_questions") return "提交门禁回答并等待 Planner 处理。";
  return "提交阻塞处理请求并等待 Scheduler 执行。";
}

function displayTaskId(taskId: string): string {
  return taskId.split(":").at(-1) ?? taskId;
}

function receiptLabel(receipt: CommandReceipt): string {
  if (receipt.status === "accepted") return "命令已接受，正在等待执行";
  if (receipt.status === "running") return "命令处理中";
  if (receipt.status === "completed") return "命令已完成";
  return "命令执行失败";
}

export function TaskActionDialog({
  task,
  onClose,
  onCompleted,
}: {
  task: GlobalTask;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const titleId = useId();
  const reasonId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const idempotencyKey = useRef(`wb-${crypto.randomUUID()}`);
  const [detail, setDetail] = useState(task);
  const [detailLoading, setDetailLoading] = useState(true);
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState("approve");
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);
  const [failure, setFailure] = useState<WorkbenchFailurePresentation | null>(null);
  const pendingReceiptId = receipt && ["accepted", "running"].includes(receipt.status)
    ? receipt.receiptId
    : null;

  useEffect(() => {
    let active = true;
    workbenchApi.getTask(task.id)
      .then((response) => {
        if (active) setDetail(response.data);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof WorkbenchApiError) {
          setFailure(presentWorkbenchFailure(error.status, error.envelope));
        }
      })
      .finally(() => {
        if (active) {
          setDetailLoading(false);
          reasonRef.current?.focus();
        }
      });
    return () => { active = false; };
  }, [task.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, submitting]);

  useEffect(() => {
    if (!pendingReceiptId) return;
    let active = true;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(() => {
        void workbenchApi.getReceipt(pendingReceiptId)
          .then((next) => {
            if (!active) return;
            setReceipt(next);
            if (next.status === "completed") onCompleted();
            if (next.status === "failed") {
              setFailure({
                title: "命令执行失败",
                body: `${next.error?.message ?? "异步命令未完成"}；任务数据和理由草稿仍保留；${next.error?.nextAction ?? "检查 Receipt 后重试"}`,
                requestId: next.requestId,
              });
            } else if (["accepted", "running"].includes(next.status)) {
              setFailure(null);
              poll();
            }
          })
          .catch((error: unknown) => {
            if (!active) return;
            if (error instanceof WorkbenchApiError) {
              setFailure(presentWorkbenchFailure(error.status, error.envelope));
            }
            poll();
          });
      }, 1_000);
    };
    poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [onCompleted, pendingReceiptId]);

  const submit = async () => {
    if (submitting || receipt && ["accepted", "running"].includes(receipt.status)) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const next = await workbenchApi.executeTaskAction(
        detail.id,
        {
          action: detail.action.id,
          expectedVersion: detail.version,
          reason,
          input: detail.action.id === "review_evidence"
            ? { decision }
            : { source: "workbench" },
        },
        idempotencyKey.current,
      );
      setReceipt(next);
    } catch (error) {
      if (error instanceof WorkbenchApiError) {
        setFailure(presentWorkbenchFailure(error.status, error.envelope));
      } else {
        setFailure({
          title: "网络请求失败",
          body: "本次操作未提交；任务数据和理由草稿仍保留；恢复连接后可使用相同幂等键重试",
          requestId: "req_unavailable",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const pending = submitting || Boolean(receipt && ["accepted", "running"].includes(receipt.status));
  return (
    <div className="task-action-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <section
        className="task-action-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={submitting || detailLoading}
      >
        <header>
          <div>
            <span>{detail.goalId} · {displayTaskId(detail.id)}</span>
            <h3 id={titleId}>{detail.action.label}：{detail.title}</h3>
          </div>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭任务操作"
            onClick={onClose}
            disabled={submitting}
          >×</button>
        </header>
        <p>{detailLoading ? "任务详情加载中…" : actionDescription(detail)}</p>
        <dl className="task-action-context">
          <div><dt>当前版本</dt><dd>v{detail.version}</dd></div>
          <div><dt>状态</dt><dd>{detail.status.label}</dd></div>
          <div><dt>影响</dt><dd>{detail.attention.impact}</dd></div>
        </dl>
        {detail.action.id === "review_evidence" && (
          <label>
            评审决定
            <select value={decision} onChange={(event) => setDecision(event.target.value)} disabled={pending}>
              <option value="approve">批准证据</option>
              <option value="request_changes">要求修改</option>
              <option value="reject">拒绝</option>
            </select>
          </label>
        )}
        <label htmlFor={reasonId}>
          操作理由
          <textarea
            ref={reasonRef}
            id={reasonId}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="说明判断依据和预期影响"
            maxLength={4_000}
            disabled={pending}
          />
        </label>
        {failure && (
          <div className="task-action-failure" role="alert">
            <strong>{failure.title}</strong>
            <span>{failure.body}</span>
            <small>请求 ID：{failure.requestId}</small>
          </div>
        )}
        <div className="task-action-receipt" aria-live="polite">
          {receipt && (
            <>
              <strong>{receiptLabel(receipt)}</strong>
              <span>{receipt.receiptId} · 任务 v{receipt.taskVersion}</span>
            </>
          )}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>
            {receipt ? "关闭" : "取消"}
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void submit()}
            disabled={pending || detailLoading || !reason.trim()}
          >
            {submitting ? "提交中…" : pending ? "处理中，请勿重复操作" : "提交异步命令"}
          </button>
        </footer>
      </section>
    </div>
  );
}
