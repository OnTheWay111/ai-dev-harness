export const goalStatuses = [
  "draft",
  "clarifying",
  "planning",
  "approved",
  "executing",
  "verifying",
  "completed",
  "cancelled",
] as const;
export type GoalStatus = (typeof goalStatuses)[number];

export const specRevisionStatuses = [
  "draft",
  "in_review",
  "approved",
  "rejected",
  "superseded",
] as const;
export type SpecRevisionStatus = (typeof specRevisionStatuses)[number];

export const issueStatuses = [
  "draft",
  "approved",
  "ready",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type IssueStatus = (typeof issueStatuses)[number];

export const runStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof runStatuses)[number];

export const transitionGuards = [
  "acceptanceVerified",
  "allIssuesCompleted",
  "approvalRecorded",
  "artifactDigestVerified",
  "clarificationsResolved",
  "completionEvidence",
  "dependenciesSatisfied",
  "issuesApproved",
  "reasonProvided",
  "replacementExists",
  "specApproved",
] as const;
export type TransitionGuard = (typeof transitionGuards)[number];

export interface StateTransition<State extends string> {
  from: State;
  to: State;
  guard?: TransitionGuard;
}

export interface StateMachine<State extends string> {
  name: string;
  states: readonly State[];
  terminalStates: readonly State[];
  transitions: readonly StateTransition<State>[];
}

export type DomainTransitionErrorCode =
  | "guard_failed"
  | "invalid_transition"
  | "terminal_state"
  | "version_conflict";

export class DomainTransitionError extends Error {
  readonly code: DomainTransitionErrorCode;

  constructor(
    code: DomainTransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainTransitionError";
    this.code = code;
  }
}

export interface TransitionStateInput<State extends string> {
  machine: StateMachine<State>;
  currentState: State;
  currentVersion: number;
  expectedVersion: number;
  nextState: State;
  guards: Readonly<Partial<Record<TransitionGuard, boolean>>>;
}

export interface StateTransitionResult<State extends string> {
  previousState: State;
  state: State;
  previousVersion: number;
  version: number;
}

export function transitionState<State extends string>(
  input: TransitionStateInput<State>,
): StateTransitionResult<State> {
  if (input.currentVersion !== input.expectedVersion) {
    throw new DomainTransitionError(
      "version_conflict",
      `${input.machine.name} version does not match expectedVersion`,
    );
  }
  if (input.machine.terminalStates.includes(input.currentState)) {
    throw new DomainTransitionError(
      "terminal_state",
      `${input.machine.name} is already terminal`,
    );
  }
  const transition = input.machine.transitions.find(
    ({ from, to }) => from === input.currentState && to === input.nextState,
  );
  if (!transition) {
    throw new DomainTransitionError(
      "invalid_transition",
      `${input.machine.name} transition is not allowed`,
    );
  }
  if (transition.guard && input.guards[transition.guard] !== true) {
    throw new DomainTransitionError(
      "guard_failed",
      `${input.machine.name} transition guard ${transition.guard} failed`,
    );
  }
  return {
    previousState: input.currentState,
    state: input.nextState,
    previousVersion: input.currentVersion,
    version: input.currentVersion + 1,
  };
}

function cancellations<State extends string>(
  states: readonly State[],
  cancelled: State,
): StateTransition<State>[] {
  return states.map((from) => ({
    from,
    to: cancelled,
    guard: "reasonProvided",
  }));
}

export const goalStateMachine: StateMachine<GoalStatus> = {
  name: "Goal",
  states: goalStatuses,
  terminalStates: ["completed", "cancelled"],
  transitions: [
    { from: "draft", to: "clarifying" },
    { from: "clarifying", to: "planning", guard: "clarificationsResolved" },
    { from: "planning", to: "approved", guard: "specApproved" },
    { from: "approved", to: "executing", guard: "issuesApproved" },
    { from: "executing", to: "verifying", guard: "allIssuesCompleted" },
    { from: "verifying", to: "completed", guard: "acceptanceVerified" },
    ...cancellations(
      ["draft", "clarifying", "planning", "approved", "executing", "verifying"],
      "cancelled",
    ),
  ],
};

export const specRevisionStateMachine: StateMachine<SpecRevisionStatus> = {
  name: "SpecRevision",
  states: specRevisionStatuses,
  terminalStates: ["rejected", "superseded"],
  transitions: [
    { from: "draft", to: "in_review", guard: "artifactDigestVerified" },
    { from: "in_review", to: "approved", guard: "approvalRecorded" },
    { from: "in_review", to: "rejected", guard: "reasonProvided" },
    { from: "draft", to: "superseded", guard: "replacementExists" },
    { from: "in_review", to: "superseded", guard: "replacementExists" },
    { from: "approved", to: "superseded", guard: "replacementExists" },
  ],
};

export const issueStateMachine: StateMachine<IssueStatus> = {
  name: "Issue",
  states: issueStatuses,
  terminalStates: ["completed", "cancelled"],
  transitions: [
    { from: "draft", to: "approved", guard: "specApproved" },
    { from: "approved", to: "ready", guard: "dependenciesSatisfied" },
    { from: "ready", to: "in_progress" },
    { from: "in_progress", to: "blocked", guard: "reasonProvided" },
    { from: "blocked", to: "ready", guard: "dependenciesSatisfied" },
    { from: "in_progress", to: "completed", guard: "completionEvidence" },
    ...cancellations(
      ["draft", "approved", "ready", "in_progress", "blocked"],
      "cancelled",
    ),
  ],
};

export const runStateMachine: StateMachine<RunStatus> = {
  name: "Run",
  states: runStatuses,
  terminalStates: ["succeeded", "failed", "cancelled"],
  transitions: [
    { from: "queued", to: "running" },
    { from: "running", to: "succeeded", guard: "completionEvidence" },
    { from: "running", to: "failed", guard: "reasonProvided" },
    { from: "queued", to: "cancelled", guard: "reasonProvided" },
    { from: "running", to: "cancelled", guard: "reasonProvided" },
  ],
};
