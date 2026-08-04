import {
  ClarificationExpiredError,
  ClarificationNotFoundError,
  type ClarificationQuestionRevision,
  type ClarificationRound,
  type ClarificationScope,
  type HumanDecision,
} from "../domain/clarification-history.ts";
import { VersionConflictError } from "../domain/errors.ts";
import type {
  AppendClarificationAnswer,
  AppendClarificationRound,
  ClarificationHistoryRepository,
} from "../ports/clarification-history-repository.ts";
import type { GoalWorkspacePool } from "./postgres-goal-workspace-repository.ts";

interface RoundRow {
  id: string; organization_id: string; project_id: string; goal_id: string;
  round_number: number; previous_round_id: string | null;
  regenerated_from_round_id: string | null; source_goal_version: number;
  planner_run_id: string; known_facts: ClarificationRound["knownFacts"];
  uncertainties: ClarificationRound["uncertainties"]; actor_id: string;
  reason: string; created_at: Date;
}
interface QuestionRow {
  id: string; organization_id: string; project_id: string; goal_id: string;
  round_id: string; thread_id: string; revision: number;
  previous_clarification_id: string | null; status: "open" | "answered";
  question: string; planner_question_id: string; rationale: string;
  blocking_level: ClarificationQuestionRevision["blockingLevel"];
  answer_type: ClarificationQuestionRevision["answerType"];
  suggested_options: string[]; answer: string | null; source_goal_version: number;
  actor_id: string; reason: string; created_at: Date;
}
interface DecisionRow {
  id: string; organization_id: string; project_id: string; goal_id: string;
  decision_key: string; revision: number; previous_decision_id: string | null;
  subject_id: string; subject_version: number; outcome: string; actor_id: string;
  reason: string; created_at: Date;
}

const mapRound = (row: RoundRow): ClarificationRound => ({
  id: row.id, organizationId: row.organization_id, projectId: row.project_id,
  goalId: row.goal_id, roundNumber: row.round_number,
  previousRoundId: row.previous_round_id,
  regeneratedFromRoundId: row.regenerated_from_round_id,
  sourceGoalVersion: row.source_goal_version, plannerRunId: row.planner_run_id,
  knownFacts: row.known_facts, uncertainties: row.uncertainties,
  actorId: row.actor_id, reason: row.reason, createdAt: row.created_at.toISOString(),
});
const mapQuestion = (row: QuestionRow): ClarificationQuestionRevision => ({
  id: row.id, organizationId: row.organization_id, projectId: row.project_id,
  goalId: row.goal_id, roundId: row.round_id, threadId: row.thread_id,
  revision: row.revision, previousClarificationId: row.previous_clarification_id,
  status: row.status, plannerQuestionId: row.planner_question_id,
  prompt: row.question, rationale: row.rationale, blockingLevel: row.blocking_level,
  answerType: row.answer_type, suggestedOptions: row.suggested_options,
  answer: row.answer, sourceGoalVersion: row.source_goal_version,
  actorId: row.actor_id, reason: row.reason, createdAt: row.created_at.toISOString(),
});
const mapDecision = (row: DecisionRow): HumanDecision => ({
  id: row.id, organizationId: row.organization_id, projectId: row.project_id,
  goalId: row.goal_id, decisionKey: row.decision_key, revision: row.revision,
  previousDecisionId: row.previous_decision_id, status: "approved",
  subjectType: "clarification", subjectId: row.subject_id,
  subjectVersion: row.subject_version, outcome: row.outcome, actorId: row.actor_id,
  reason: row.reason, createdAt: row.created_at.toISOString(),
});

const values = (scope: ClarificationScope) =>
  [scope.organizationId, scope.projectId, scope.goalId] as const;

interface QueryExecutor {
  query<Row extends object>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

async function insertQuestion(executor: QueryExecutor, question: ClarificationQuestionRevision) {
  await executor.query(
    `INSERT INTO clarifications
       (id, organization_id, project_id, goal_id, round_id, thread_id, revision,
        previous_clarification_id, status, question, planner_question_id,
        rationale, blocking_level, answer_type, suggested_options, answer,
        source_goal_version, actor_id, reason, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20)`,
    [question.id, question.organizationId, question.projectId, question.goalId,
      question.roundId, question.threadId, question.revision,
      question.previousClarificationId, question.status, question.prompt,
      question.plannerQuestionId, question.rationale, question.blockingLevel,
      question.answerType, JSON.stringify(question.suggestedOptions), question.answer,
      question.sourceGoalVersion, question.actorId, question.reason,
      new Date(question.createdAt)],
  );
}

export class PostgresClarificationHistoryRepository implements ClarificationHistoryRepository {
  private readonly pool: GoalWorkspacePool;

  constructor(pool: GoalWorkspacePool) {
    this.pool = pool;
  }

  async getTimeline(scope: ClarificationScope) {
    const [rounds, questions, decisions] = await Promise.all([
      this.pool.query<RoundRow>(
        `SELECT * FROM clarification_rounds WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 ORDER BY round_number`,
        values(scope),
      ),
      this.pool.query<QuestionRow>(
        `SELECT * FROM clarifications WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 ORDER BY created_at, thread_id, revision`,
        values(scope),
      ),
      this.pool.query<DecisionRow>(
        `SELECT * FROM decisions WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 AND subject_type='clarification' ORDER BY created_at, decision_key, revision`,
        values(scope),
      ),
    ]);
    return {
      rounds: rounds.rows.map(mapRound),
      questions: questions.rows.map(mapQuestion),
      decisions: decisions.rows.map(mapDecision),
    };
  }

  async appendRound(command: AppendClarificationRound) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const goal = await client.query<{ version: number }>(
        `SELECT version FROM goals WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
        values(command.round),
      );
      if (goal.rows[0]?.version !== command.expectedGoalVersion) throw new ClarificationExpiredError();
      const latest = await client.query<{ id: string }>(
        `SELECT id FROM clarification_rounds WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 ORDER BY round_number DESC LIMIT 1 FOR UPDATE`,
        values(command.round),
      );
      if ((latest.rows[0]?.id ?? null) !== command.expectedPreviousRoundId) throw new VersionConflictError();
      const round = command.round;
      await client.query(
        `INSERT INTO clarification_rounds
          (id, organization_id, project_id, goal_id, round_number, previous_round_id,
           regenerated_from_round_id, source_goal_version, planner_run_id,
           known_facts, uncertainties, actor_id, reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14)`,
        [round.id, round.organizationId, round.projectId, round.goalId,
          round.roundNumber, round.previousRoundId, round.regeneratedFromRoundId,
          round.sourceGoalVersion, round.plannerRunId, JSON.stringify(round.knownFacts),
          JSON.stringify(round.uncertainties), round.actorId, round.reason,
          new Date(round.createdAt)],
      );
      for (const question of command.questions) await insertQuestion(client, question);
      await client.query("COMMIT");
      return structuredClone({ round: command.round, questions: command.questions });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") throw new VersionConflictError();
      throw error;
    } finally { client.release(); }
  }

  async appendAnswer(command: AppendClarificationAnswer) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const goal = await client.query<{ version: number }>(
        `SELECT version FROM goals WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
        values(command.question),
      );
      if (goal.rows[0]?.version !== command.expectedGoalVersion) throw new ClarificationExpiredError();
      const latestRound = await client.query<{ id: string }>(
        `SELECT id FROM clarification_rounds WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 ORDER BY round_number DESC LIMIT 1 FOR UPDATE`,
        values(command.question),
      );
      const current = await client.query<QuestionRow>(
        `SELECT * FROM clarifications WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 AND thread_id=$4 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        [...values(command.question), command.question.threadId],
      );
      const row = current.rows[0];
      if (!row) throw new ClarificationNotFoundError();
      if (row.id !== command.expectedQuestionId || row.revision !== command.expectedQuestionRevision) throw new VersionConflictError();
      if (row.round_id !== latestRound.rows[0]?.id || row.source_goal_version !== command.expectedGoalVersion) throw new ClarificationExpiredError();
      await insertQuestion(client, command.question);
      const decision = command.decision;
      await client.query(
        `INSERT INTO decisions
          (id, organization_id, project_id, goal_id, decision_key, revision,
           previous_decision_id, status, subject_type, subject_id, subject_version,
           outcome, actor_id, reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'approved','clarification',$8,$9,$10,$11,$12,$13)`,
        [decision.id, decision.organizationId, decision.projectId, decision.goalId,
          decision.decisionKey, decision.revision, decision.previousDecisionId,
          decision.subjectId, decision.subjectVersion, decision.outcome,
          decision.actorId, decision.reason, new Date(decision.createdAt)],
      );
      await client.query("COMMIT");
      return structuredClone({ question: command.question, decision: command.decision });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") throw new VersionConflictError();
      throw error;
    } finally { client.release(); }
  }
}
