import { VersionConflictError } from "../domain/errors.ts";
import type {
  GoalAcceptanceCriterion,
  GoalContract,
  GoalContractDraft,
} from "../domain/goal-contract.ts";
import type {
  GoalWorkspaceAuthorizer,
  GoalWorkspaceEndpoint,
  GoalWorkspaceRepository,
  GoalWorkspaceReceipt,
} from "../ports/goal-workspace-repository.ts";

export class GoalWorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalWorkspaceValidationError";
  }
}

export class GoalWorkspaceNotFoundError extends Error {
  constructor() {
    super("Goal was not found in the authorized scope");
    this.name = "GoalWorkspaceNotFoundError";
  }
}

interface CommandIdentity {
  organizationId: string;
  projectId: string;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  reason: string;
}

export interface CreateGoalCommand extends CommandIdentity {
  draft: GoalContractDraft;
}

export interface ReadGoalCommand {
  organizationId: string;
  projectId: string;
  goalId: string;
  actorId: string;
}

export interface UpdateGoalCommand extends CommandIdentity {
  goalId: string;
  expectedVersion: number;
  draft: GoalContractDraft;
}

function boundedText(value: string, name: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new GoalWorkspaceValidationError(`${name} must be text`);
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new GoalWorkspaceValidationError(`${name} is required and bounded`);
  }
  return normalized;
}

function boundedList(
  value: readonly string[],
  name: string,
  options: { minimum?: number; maximumItems?: number; maximumLength: number },
): string[] {
  if (!Array.isArray(value)) {
    throw new GoalWorkspaceValidationError(`${name} must be a list`);
  }
  const minimum = options.minimum ?? 0;
  const maximumItems = options.maximumItems ?? 50;
  if (value.length < minimum || value.length > maximumItems) {
    throw new GoalWorkspaceValidationError(`${name} has an invalid item count`);
  }
  const normalized = value.map((item, index) =>
    boundedText(item, `${name}[${index}]`, options.maximumLength)
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new GoalWorkspaceValidationError(`${name} contains duplicates`);
  }
  return normalized;
}

export function normalizeGoalContractDraft(
  draft: GoalContractDraft,
): GoalContractDraft {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new GoalWorkspaceValidationError("draft is required");
  }
  return {
    title: boundedText(draft.title, "title", 200),
    problemStatement: boundedText(
      draft.problemStatement,
      "problemStatement",
      10_000,
    ),
    desiredOutcome: boundedText(
      draft.desiredOutcome,
      "desiredOutcome",
      10_000,
    ),
    acceptanceCriteria: boundedList(
      draft.acceptanceCriteria,
      "acceptanceCriteria",
      { minimum: 1, maximumItems: 50, maximumLength: 2_000 },
    ),
    nonGoals: boundedList(draft.nonGoals, "nonGoals", {
      maximumItems: 50,
      maximumLength: 2_000,
    }),
    constraints: boundedList(draft.constraints, "constraints", {
      maximumItems: 50,
      maximumLength: 2_000,
    }),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalCommand(
  endpoint: GoalWorkspaceEndpoint,
  command: CreateGoalCommand | UpdateGoalCommand,
  draft: GoalContractDraft,
): string {
  return JSON.stringify({
    endpoint,
    organizationId: command.organizationId,
    projectId: command.projectId,
    actorId: command.actorId,
    goalId: "goalId" in command ? command.goalId : undefined,
    expectedVersion: "expectedVersion" in command
      ? command.expectedVersion
      : undefined,
    reason: command.reason.trim(),
    draft,
  });
}

export interface GoalWorkspaceDependencies {
  repository: GoalWorkspaceRepository;
  authorizer: GoalWorkspaceAuthorizer;
  clock?: () => Date;
  idGenerator?: () => string;
}

export class GoalWorkspaceService {
  private readonly repository: GoalWorkspaceRepository;
  private readonly authorizer: GoalWorkspaceAuthorizer;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(dependencies: GoalWorkspaceDependencies) {
    this.repository = dependencies.repository;
    this.authorizer = dependencies.authorizer;
    this.clock = dependencies.clock ?? (() => new Date());
    this.idGenerator = dependencies.idGenerator ?? (() => crypto.randomUUID());
  }

  async get(command: ReadGoalCommand): Promise<GoalContract> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "goal.read",
    });
    const goal = await this.repository.get({
      id: command.goalId,
      organizationId: command.organizationId,
      projectId: command.projectId,
    });
    if (!goal) throw new GoalWorkspaceNotFoundError();
    return goal;
  }

  async create(command: CreateGoalCommand): Promise<GoalWorkspaceReceipt> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "goal.write",
    });
    const draft = normalizeGoalContractDraft(command.draft);
    const reason = boundedText(command.reason, "reason", 4_000);
    const requestHash = await sha256(canonicalCommand("goal.create", command, draft));
    const lookup = this.idempotency(command, "goal.create", requestHash);
    const replay = await this.repository.findIdempotentReceipt(lookup);
    if (replay) return replay;

    const occurredAt = this.clock();
    const occurredAtIso = occurredAt.toISOString();
    const goalId = this.idGenerator();
    const criteria: GoalAcceptanceCriterion[] = draft.acceptanceCriteria.map(
      (statement, index) => ({
        id: this.idGenerator(),
        position: index + 1,
        statement,
        version: 1,
      }),
    );
    const goal: GoalContract = {
      id: goalId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      title: draft.title,
      problemStatement: draft.problemStatement,
      desiredOutcome: draft.desiredOutcome,
      acceptanceCriteria: criteria,
      nonGoals: draft.nonGoals,
      constraints: draft.constraints,
      status: "draft",
      version: 1,
      createdAt: occurredAtIso,
      updatedAt: occurredAtIso,
    };
    const eventId = this.idGenerator();
    const receipt: GoalWorkspaceReceipt = {
      operation: "created",
      goal,
      eventId,
      occurredAt: occurredAtIso,
    };
    return await this.repository.commitCreate({
      goal,
      event: this.event(eventId, "goal.created", goal, command, occurredAtIso),
      audit: this.audit("goal.created", goal, command, reason, occurredAtIso),
      idempotency: {
        ...lookup,
        responseDigest: await sha256(JSON.stringify(receipt)),
        expiresAt: new Date(occurredAt.getTime() + 24 * 60 * 60 * 1_000),
      },
      receipt,
    });
  }

  async update(command: UpdateGoalCommand): Promise<GoalWorkspaceReceipt> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "goal.write",
    });
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) {
      throw new GoalWorkspaceValidationError("expectedVersion must be positive");
    }
    const draft = normalizeGoalContractDraft(command.draft);
    const reason = boundedText(command.reason, "reason", 4_000);
    const requestHash = await sha256(canonicalCommand("goal.update", command, draft));
    const lookup = this.idempotency(command, "goal.update", requestHash);
    const replay = await this.repository.findIdempotentReceipt(lookup);
    if (replay) return replay;

    const current = await this.repository.get({
      id: command.goalId,
      organizationId: command.organizationId,
      projectId: command.projectId,
    });
    if (!current) throw new GoalWorkspaceNotFoundError();
    if (current.version !== command.expectedVersion) throw new VersionConflictError();
    const occurredAt = this.clock();
    const occurredAtIso = occurredAt.toISOString();
    const next: GoalContract = {
      ...current,
      ...draft,
      acceptanceCriteria: draft.acceptanceCriteria.map((statement, index) => ({
        id: this.idGenerator(),
        position: index + 1,
        statement,
        version: 1,
      })),
      version: current.version + 1,
      updatedAt: occurredAtIso,
    };
    const eventId = this.idGenerator();
    const receipt: GoalWorkspaceReceipt = {
      operation: "updated",
      goal: next,
      eventId,
      occurredAt: occurredAtIso,
    };
    return await this.repository.commitUpdate({
      current,
      next,
      expectedVersion: command.expectedVersion,
      event: this.event(eventId, "goal.updated", next, command, occurredAtIso),
      audit: this.audit("goal.updated", next, command, reason, occurredAtIso),
      idempotency: {
        ...lookup,
        responseDigest: await sha256(JSON.stringify(receipt)),
        expiresAt: new Date(occurredAt.getTime() + 24 * 60 * 60 * 1_000),
      },
      receipt,
    });
  }

  private idempotency(
    command: CommandIdentity,
    endpoint: GoalWorkspaceEndpoint,
    requestHash: string,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(command.idempotencyKey)) {
      throw new GoalWorkspaceValidationError("Idempotency-Key is required");
    }
    return {
      organizationId: command.organizationId,
      actorId: command.actorId,
      endpoint,
      key: command.idempotencyKey,
      requestHash,
    };
  }

  private event(
    id: string,
    type: "goal.created" | "goal.updated",
    goal: GoalContract,
    command: CommandIdentity,
    occurredAt: string,
  ) {
    return {
      id,
      organizationId: goal.organizationId,
      aggregateType: "goal" as const,
      aggregateId: goal.id,
      aggregateVersion: goal.version,
      type,
      occurredAt,
      payload: {
        actorId: command.actorId,
        requestId: command.requestId,
        reason: command.reason.trim(),
      },
    };
  }

  private audit(
    action: "goal.created" | "goal.updated",
    goal: GoalContract,
    command: CommandIdentity,
    reason: string,
    createdAt: string,
  ) {
    return {
      id: this.idGenerator(),
      organizationId: goal.organizationId,
      projectId: goal.projectId,
      goalId: goal.id,
      actorId: command.actorId,
      action,
      entityType: "goal" as const,
      entityId: goal.id,
      entityVersion: goal.version,
      reason,
      requestId: command.requestId,
      createdAt,
    };
  }
}
