import type { GoalStatus } from "../domain/state-machines.ts";

export interface GoalScope {
  id: string;
  organizationId: string;
  projectId: string;
}

export interface GoalAggregate extends GoalScope {
  title: string;
  status: GoalStatus;
  version: number;
}

export interface GoalStateChangedEvent {
  id: string;
  organizationId: string;
  aggregateType: "goal";
  aggregateId: string;
  aggregateVersion: number;
  type: "goal.state_changed";
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface CommitGoalTransition {
  current: GoalAggregate;
  expectedVersion: number;
  nextState: GoalStatus;
  occurredAt: Date;
  event: GoalStateChangedEvent;
}

export interface GoalRepository {
  get(scope: GoalScope): Promise<GoalAggregate | null>;
  commitTransition(command: CommitGoalTransition): Promise<GoalAggregate>;
}
