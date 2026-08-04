export class VersionConflictError extends Error {
  constructor() {
    super("The entity version changed before the transition was persisted");
    this.name = "VersionConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The Idempotency-Key was already used for a different command");
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyInProgressError extends Error {
  constructor() {
    super("The command with this Idempotency-Key is still in progress");
    this.name = "IdempotencyInProgressError";
  }
}

export class CommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandValidationError";
  }
}
