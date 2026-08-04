export type ExternalExecutionState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface ExecutionStartRequest {
  externalTaskId: string;
  externalRunId: string;
  selectedSecrets: readonly string[];
  timeoutMs: number;
}

export interface ExternalExecutionStatus {
  externalRunId: string;
  state: ExternalExecutionState;
  phase: string;
  message?: string;
}

export interface ExecutionGatewayPort {
  start(request: ExecutionStartRequest): Promise<ExternalExecutionStatus>;
  inspect(externalRunId: string): Promise<ExternalExecutionStatus | null>;
  cancel(externalRunId: string): Promise<void>;
}
