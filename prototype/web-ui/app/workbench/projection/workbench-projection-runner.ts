import type { WorkbenchSnapshot } from "../contracts.ts";
import {
  buildWorkbenchSnapshot,
  type WorkbenchProjectionFacts,
  type WorkbenchProjectionScope,
  workbenchFactsWatermark,
  workbenchSemanticDigest,
} from "./workbench-projection.ts";

export interface WorkbenchProjectionCursor {
  occurredAt: string;
  eventId: string;
}

export interface WorkbenchProjectionSource {
  listScopes(): Promise<readonly WorkbenchProjectionScope[]>;
  latestTrigger(scope: WorkbenchProjectionScope): Promise<WorkbenchProjectionCursor | null>;
  loadFacts(scope: WorkbenchProjectionScope): Promise<WorkbenchProjectionFacts>;
}

export interface WorkbenchProjectionState {
  cursor: WorkbenchProjectionCursor | null;
  digest: string;
  revision: number;
  snapshot: WorkbenchSnapshot;
}

export interface WorkbenchProjectionPublisher {
  readState(scope: WorkbenchProjectionScope): Promise<WorkbenchProjectionState | null>;
  publish(input: {
    scope: WorkbenchProjectionScope;
    cursor: WorkbenchProjectionCursor | null;
    digest: string;
    snapshot: WorkbenchSnapshot;
  }): Promise<WorkbenchProjectionState>;
}

function scopeKey(scope: WorkbenchProjectionScope): string {
  return `${scope.scopeId}\0${scope.organizationId}\0${scope.projectId}`;
}

function sameCursor(
  left: WorkbenchProjectionCursor | null,
  right: WorkbenchProjectionCursor | null,
): boolean {
  return left?.eventId === right?.eventId && left?.occurredAt === right?.occurredAt;
}

export class WorkbenchProjectionRunner {
  private readonly source: WorkbenchProjectionSource;
  private readonly publisher: WorkbenchProjectionPublisher;
  private readonly clock: () => Date;
  private readonly scopeQueues = new Map<string, Promise<unknown>>();

  constructor(input: {
    source: WorkbenchProjectionSource;
    publisher: WorkbenchProjectionPublisher;
    clock?: () => Date;
  }) {
    this.source = input.source;
    this.publisher = input.publisher;
    this.clock = input.clock ?? (() => new Date());
  }

  async runOnce(): Promise<void> {
    const scopes = await this.source.listScopes();
    await Promise.all(scopes.map((scope) => this.projectScope(scope)));
  }

  async replay(scope: WorkbenchProjectionScope): Promise<WorkbenchProjectionState> {
    return await this.projectScope(scope, true);
  }

  projectScope(
    scope: WorkbenchProjectionScope,
    force = false,
  ): Promise<WorkbenchProjectionState> {
    const key = scopeKey(scope);
    const previous = this.scopeQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const [current, cursor] = await Promise.all([
        this.publisher.readState(scope),
        this.source.latestTrigger(scope),
      ]);
      if (!force && current && sameCursor(current.cursor, cursor)) return current;
      const projectionFacts = await this.source.loadFacts(scope);
      const generatedAt = workbenchFactsWatermark(
        projectionFacts,
        this.clock().toISOString(),
      );
      const snapshot = buildWorkbenchSnapshot(projectionFacts, {
        revision: (current?.revision ?? 0) + 1,
        generatedAt,
      });
      return await this.publisher.publish({
        scope,
        cursor,
        digest: await workbenchSemanticDigest(snapshot),
        snapshot,
      });
    });
    this.scopeQueues.set(key, next);
    next.finally(() => {
      if (this.scopeQueues.get(key) === next) this.scopeQueues.delete(key);
    }).catch(() => undefined);
    return next;
  }
}

export class MemoryWorkbenchProjectionPublisher
  implements WorkbenchProjectionPublisher
{
  private readonly states = new Map<string, WorkbenchProjectionState>();

  get(scope: WorkbenchProjectionScope): WorkbenchProjectionState {
    const state = this.states.get(scopeKey(scope));
    if (!state) throw new Error("Workbench projection has not been published");
    return structuredClone(state);
  }

  async readState(scope: WorkbenchProjectionScope): Promise<WorkbenchProjectionState | null> {
    const state = this.states.get(scopeKey(scope));
    return state ? structuredClone(state) : null;
  }

  async publish(input: {
    scope: WorkbenchProjectionScope;
    cursor: WorkbenchProjectionCursor | null;
    digest: string;
    snapshot: WorkbenchSnapshot;
  }): Promise<WorkbenchProjectionState> {
    const key = scopeKey(input.scope);
    const current = this.states.get(key);
    const next = current?.digest === input.digest
      ? { ...current, cursor: input.cursor }
      : {
          cursor: input.cursor,
          digest: input.digest,
          revision: (current?.revision ?? 0) + 1,
          snapshot: {
            ...structuredClone(input.snapshot),
            revision: (current?.revision ?? 0) + 1,
          },
        };
    this.states.set(key, structuredClone(next));
    return structuredClone(next);
  }
}
