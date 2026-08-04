import { VersionConflictError } from "../domain/errors.ts";
import type {
  CommitGoalTransition,
  GoalAggregate,
  GoalRepository,
  GoalScope,
  GoalStateChangedEvent,
} from "../ports/goal-repository.ts";

function key(scope: GoalScope): string {
  return `${scope.organizationId}/${scope.projectId}/${scope.id}`;
}

export class MemoryGoalRepository implements GoalRepository {
  private readonly goals = new Map<string, GoalAggregate>();
  private readonly events: GoalStateChangedEvent[] = [];

  constructor(initialGoals: readonly GoalAggregate[] = []) {
    for (const goal of initialGoals) {
      this.goals.set(key(goal), { ...goal });
    }
  }

  get committedEvents(): GoalStateChangedEvent[] {
    return structuredClone(this.events);
  }

  async get(scope: GoalScope): Promise<GoalAggregate | null> {
    const goal = this.goals.get(key(scope));
    return goal ? { ...goal } : null;
  }

  async commitTransition(
    command: CommitGoalTransition,
  ): Promise<GoalAggregate> {
    const current = this.goals.get(key(command.current));
    if (
      !current ||
      current.version !== command.expectedVersion ||
      command.event.aggregateVersion !== command.expectedVersion + 1
    ) {
      throw new VersionConflictError();
    }
    if (
      this.events.some((event) =>
        event.id === command.event.id ||
        (event.aggregateId === command.event.aggregateId &&
          event.aggregateVersion === command.event.aggregateVersion &&
          event.type === command.event.type)
      )
    ) {
      throw new VersionConflictError();
    }
    const next = {
      ...current,
      status: command.nextState,
      version: command.expectedVersion + 1,
    };
    this.goals.set(key(next), next);
    this.events.push(structuredClone(command.event));
    return { ...next };
  }
}
