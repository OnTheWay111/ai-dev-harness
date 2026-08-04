import {
  ClarificationExpiredError,
  ClarificationNotFoundError,
  type ClarificationTimeline,
  type ClarificationScope,
} from "../domain/clarification-history.ts";
import { VersionConflictError } from "../domain/errors.ts";
import type {
  AppendClarificationAnswer,
  AppendClarificationRound,
  ClarificationHistoryRepository,
} from "../ports/clarification-history-repository.ts";

function key(scope: ClarificationScope): string {
  return `${scope.organizationId}/${scope.projectId}/${scope.goalId}`;
}

const empty = (): ClarificationTimeline => ({ rounds: [], questions: [], decisions: [] });

export class MemoryClarificationHistoryRepository implements ClarificationHistoryRepository {
  private readonly timelines = new Map<string, ClarificationTimeline>();

  async getTimeline(scope: ClarificationScope): Promise<ClarificationTimeline> {
    return structuredClone(this.timelines.get(key(scope)) ?? empty());
  }

  async appendRound(command: AppendClarificationRound) {
    const timeline = this.timelines.get(key(command.round)) ?? empty();
    const latest = timeline.rounds.at(-1) ?? null;
    if ((latest?.id ?? null) !== command.expectedPreviousRoundId) {
      throw new VersionConflictError();
    }
    if (command.round.sourceGoalVersion !== command.expectedGoalVersion) {
      throw new ClarificationExpiredError();
    }
    timeline.rounds.push(structuredClone(command.round));
    timeline.questions.push(...structuredClone(command.questions));
    this.timelines.set(key(command.round), timeline);
    return structuredClone({ round: command.round, questions: command.questions });
  }

  async appendAnswer(command: AppendClarificationAnswer) {
    const timeline = this.timelines.get(key(command.question));
    if (!timeline) throw new ClarificationNotFoundError();
    const latestRound = timeline.rounds.at(-1);
    const revisions = timeline.questions.filter(({ threadId }) =>
      threadId === command.question.threadId
    );
    const latest = revisions.at(-1);
    if (!latest) throw new ClarificationNotFoundError();
    if (
      latest.id !== command.expectedQuestionId ||
      latest.revision !== command.expectedQuestionRevision
    ) throw new VersionConflictError();
    if (
      !latestRound || latest.roundId !== latestRound.id ||
      latest.sourceGoalVersion !== command.expectedGoalVersion
    ) throw new ClarificationExpiredError();
    timeline.questions.push(structuredClone(command.question));
    timeline.decisions.push(structuredClone(command.decision));
    return structuredClone({ question: command.question, decision: command.decision });
  }
}
