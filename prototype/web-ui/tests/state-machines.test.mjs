import assert from "node:assert/strict";
import test from "node:test";

import {
  DomainTransitionError,
  goalStateMachine,
  issueStateMachine,
  runStateMachine,
  specRevisionStateMachine,
  transitionState,
} from "../app/control-plane/domain/state-machines.ts";

const validCases = [
  [goalStateMachine, "draft", "clarifying", {}],
  [goalStateMachine, "clarifying", "planning", { clarificationsResolved: true }],
  [goalStateMachine, "planning", "approved", { specApproved: true }],
  [goalStateMachine, "approved", "executing", { issuesApproved: true }],
  [goalStateMachine, "executing", "verifying", { allIssuesCompleted: true }],
  [goalStateMachine, "verifying", "completed", { acceptanceVerified: true }],
  [specRevisionStateMachine, "draft", "in_review", { artifactDigestVerified: true }],
  [specRevisionStateMachine, "in_review", "approved", { approvalRecorded: true }],
  [issueStateMachine, "draft", "approved", { specApproved: true }],
  [issueStateMachine, "approved", "ready", { dependenciesSatisfied: true }],
  [issueStateMachine, "ready", "in_progress", {}],
  [issueStateMachine, "in_progress", "completed", { completionEvidence: true }],
  [runStateMachine, "queued", "running", {}],
  [runStateMachine, "running", "succeeded", { completionEvidence: true }],
];

test("allows only declared guarded transitions and increments version once", () => {
  for (const [machine, from, to, guards] of validCases) {
    assert.deepEqual(
      transitionState({
        machine,
        currentState: from,
        currentVersion: 7,
        expectedVersion: 7,
        nextState: to,
        guards,
      }),
      { previousState: from, state: to, previousVersion: 7, version: 8 },
      `${machine.name}: ${from} -> ${to}`,
    );
  }
});

test("rejects stale versions before evaluating a transition", () => {
  assert.throws(
    () =>
      transitionState({
        machine: goalStateMachine,
        currentState: "draft",
        currentVersion: 3,
        expectedVersion: 2,
        nextState: "clarifying",
        guards: {},
      }),
    (error) =>
      error instanceof DomainTransitionError &&
      error.code === "version_conflict",
  );
});

test("rejects undeclared, unguarded, and terminal transitions", () => {
  const cases = [
    [goalStateMachine, "draft", "completed", {}, "invalid_transition"],
    [goalStateMachine, "clarifying", "planning", {}, "guard_failed"],
    [specRevisionStateMachine, "in_review", "approved", {}, "guard_failed"],
    [issueStateMachine, "approved", "ready", {}, "guard_failed"],
    [runStateMachine, "running", "succeeded", {}, "guard_failed"],
    [goalStateMachine, "completed", "executing", {}, "terminal_state"],
    [issueStateMachine, "cancelled", "ready", {}, "terminal_state"],
    [runStateMachine, "failed", "running", {}, "terminal_state"],
  ];
  for (const [machine, from, to, guards, code] of cases) {
    assert.throws(
      () =>
        transitionState({
          machine,
          currentState: from,
          currentVersion: 1,
          expectedVersion: 1,
          nextState: to,
          guards,
        }),
      (error) => error instanceof DomainTransitionError && error.code === code,
      `${machine.name}: ${from} -> ${to}`,
    );
  }
});

test("requires a reason for explicit cancellation, failure, or rejection", () => {
  for (const [machine, from, to] of [
    [goalStateMachine, "planning", "cancelled"],
    [specRevisionStateMachine, "in_review", "rejected"],
    [issueStateMachine, "blocked", "cancelled"],
    [runStateMachine, "running", "failed"],
  ]) {
    assert.throws(
      () =>
        transitionState({
          machine,
          currentState: from,
          currentVersion: 1,
          expectedVersion: 1,
          nextState: to,
          guards: {},
        }),
      (error) =>
        error instanceof DomainTransitionError && error.code === "guard_failed",
    );
    assert.equal(
      transitionState({
        machine,
        currentState: from,
        currentVersion: 1,
        expectedVersion: 1,
        nextState: to,
        guards: { reasonProvided: true },
      }).version,
      2,
    );
  }
});
