import {
  buildPlannerContextPacket,
  PlannerExecutionError,
  type PlannerDraft,
  type PlannerPort,
  type PlannerRequest,
} from "../ports/planner-port.ts";

export class FakePlannerAdapter implements PlannerPort {
  private readonly outputs: unknown[];
  readonly requests: ReturnType<typeof buildPlannerContextPacket>[] = [];

  constructor(outputs: readonly unknown[]) {
    this.outputs = [...outputs];
  }

  async plan<T = unknown>(request: PlannerRequest): Promise<PlannerDraft<T>> {
    const packet = buildPlannerContextPacket(request.goal);
    this.requests.push(packet);
    if (this.outputs.length === 0) throw new PlannerExecutionError("planner_failed");
    return {
      status: "draft",
      plannerRunId: crypto.randomUUID(),
      goalId: packet.goalId,
      sourceGoalVersion: packet.goalVersion,
      output: structuredClone(this.outputs.shift()) as T,
    };
  }
}
