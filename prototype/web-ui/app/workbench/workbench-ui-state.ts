import type { ApiErrorEnvelope } from "./contracts.ts";

export interface WorkbenchFailurePresentation {
  title: string;
  body: string;
  requestId: string;
}

export function presentWorkbenchFailure(
  status: number,
  envelope: ApiErrorEnvelope,
): WorkbenchFailurePresentation {
  const title = status === 401 || status === 403
    ? "无权限"
    : status === 409
    ? "状态冲突"
    : status >= 500
    ? "服务暂时不可用"
    : "请求未完成";
  const parts = [
    envelope.error.message,
    envelope.error.impact,
    envelope.error.preservedState,
    envelope.error.nextAction,
  ].filter((part): part is string => Boolean(part?.trim()));
  return {
    title,
    body: parts.join("；"),
    requestId: envelope.requestId,
  };
}
