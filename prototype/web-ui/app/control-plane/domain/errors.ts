export class VersionConflictError extends Error {
  constructor() {
    super("The entity version changed before the transition was persisted");
    this.name = "VersionConflictError";
  }
}
