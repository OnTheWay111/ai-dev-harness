import type {
  WorkbenchApi,
  WorkbenchSnapshot,
} from "./contracts.ts";

export type WorkbenchRealtimeState =
  | "connecting"
  | "connected"
  | "refreshing"
  | "reconnecting"
  | "stopped";

interface MessageEventLike {
  data: string;
  lastEventId?: string;
}

export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(
    type: string,
    listener: (event: MessageEventLike) => void,
  ): void;
  close(): void;
}

type ScheduleToken = unknown;

export class WorkbenchRealtimeClient {
  private readonly api: Pick<WorkbenchApi, "getWorkbench">;
  private readonly eventSourceFactory: (url: string) => EventSourceLike;
  private readonly schedule: (callback: () => void, delay: number) => ScheduleToken;
  private readonly cancelSchedule: (token: ScheduleToken) => void;
  private readonly onSnapshot: (snapshot: WorkbenchSnapshot) => void;
  private readonly onState: (state: WorkbenchRealtimeState) => void;
  private readonly onError: (error: unknown) => void;
  private source: EventSourceLike | null = null;
  private reconnectTimer: ScheduleToken | null = null;
  private currentRevision = 0;
  private running = false;
  private reconnectAttempt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(input: {
    api: Pick<WorkbenchApi, "getWorkbench">;
    eventSourceFactory?: (url: string) => EventSourceLike;
    schedule?: (callback: () => void, delay: number) => ScheduleToken;
    cancelSchedule?: (token: ScheduleToken) => void;
    onSnapshot: (snapshot: WorkbenchSnapshot) => void;
    onState?: (state: WorkbenchRealtimeState) => void;
    onError?: (error: unknown) => void;
  }) {
    this.api = input.api;
    this.eventSourceFactory = input.eventSourceFactory ??
      ((url) => new EventSource(url) as unknown as EventSourceLike);
    this.schedule = input.schedule ?? ((callback, delay) => window.setTimeout(callback, delay));
    this.cancelSchedule = input.cancelSchedule ?? ((token) => window.clearTimeout(token as number));
    this.onSnapshot = input.onSnapshot;
    this.onState = input.onState ?? (() => undefined);
    this.onError = input.onError ?? (() => undefined);
  }

  start(revision: number): void {
    if (this.running) return;
    this.running = true;
    this.currentRevision = Math.max(0, revision);
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.source?.close();
    this.source = null;
    if (this.reconnectTimer !== null) {
      this.cancelSchedule(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.onState("stopped");
  }

  private connect(): void {
    if (!this.running) return;
    this.onState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const source = this.eventSourceFactory(
      `/api/v1/workbench/events?afterRevision=${this.currentRevision}`,
    );
    this.source = source;
    source.addEventListener(
      "workbench.snapshot.invalidated",
      (event) => void this.handleInvalidation(event),
    );
    source.onopen = () => {
      if (!this.running || this.source !== source) return;
      this.reconnectAttempt = 0;
      this.onState("connected");
    };
    source.onerror = () => {
      if (!this.running || this.source !== source) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== null) return;
    this.source?.close();
    this.source = null;
    this.reconnectAttempt += 1;
    this.onState("reconnecting");
    const delay = Math.min(30_000, 1_000 * (2 ** (this.reconnectAttempt - 1)));
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async handleInvalidation(event: MessageEventLike): Promise<void> {
    if (!this.running) return;
    let revision: number;
    try {
      revision = Number((JSON.parse(event.data) as { revision?: unknown }).revision);
    } catch {
      return;
    }
    if (!Number.isSafeInteger(revision) || revision <= this.currentRevision) return;
    if (this.refreshPromise) {
      await this.refreshPromise;
      if (revision <= this.currentRevision) return;
    }
    this.refreshPromise = this.refresh(revision);
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async refresh(advertisedRevision: number): Promise<void> {
    this.onState("refreshing");
    try {
      // Events carry invalidations only. Every advance, and especially a jump,
      // resolves through the authoritative snapshot/ETag cache.
      const response = await this.api.getWorkbench({ limit: 50 });
      if (response.data.revision < advertisedRevision) {
        throw new Error("Authoritative snapshot has not reached the advertised revision");
      }
      if (response.data.revision >= this.currentRevision) {
        this.currentRevision = response.data.revision;
        this.onSnapshot(response.data);
      }
      this.reconnectAttempt = 0;
      this.onState("connected");
    } catch (error) {
      this.onError(error);
      this.scheduleReconnect();
    }
  }
}
