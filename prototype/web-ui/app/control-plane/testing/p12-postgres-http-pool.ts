import { usesP12ContractAdapters } from "./p12-runtime-config.ts";

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface BridgeEnvelope {
  result?: unknown;
  error?: string;
}

interface P12PostgresBridgeConfig {
  url: string;
  token: string;
}

function readBridgeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): P12PostgresBridgeConfig {
  const url = environment.P12_POSTGRES_BRIDGE_URL?.trim();
  const token = environment.P12_POSTGRES_BRIDGE_TOKEN?.trim();
  if (!url || !token) {
    throw new Error(
      "P12 PostgreSQL bridge URL and token are required in contract mode",
    );
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" ||
    !(parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) {
    throw new Error("P12 PostgreSQL bridge must be loopback HTTP");
  }
  return { url: parsed.toString(), token };
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.__p12Type === "date" && typeof record.value === "string") {
    return new Date(record.value);
  }
  if (record.__p12Type === "bytes" && typeof record.value === "string") {
    return Uint8Array.from(atob(record.value), (character) =>
      character.charCodeAt(0));
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, decode(item)]),
  );
}

class P12PostgresHttpClient {
  private readonly pool: P12PostgresHttpPool;
  private readonly sessionId: string;
  private released = false;

  constructor(pool: P12PostgresHttpPool, sessionId: string) {
    this.pool = pool;
    this.sessionId = sessionId;
  }

  async query<Row extends object>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    if (this.released) throw new Error("P12 PostgreSQL client was released");
    try {
      return await this.pool.bridgeQuery<Row>(text, values, this.sessionId);
    } finally {
      if (/^\s*(COMMIT|ROLLBACK)\b/i.test(text)) {
        await this.pool.releaseSession(this.sessionId);
        this.released = true;
      }
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    void this.pool.releaseSession(this.sessionId);
  }
}

/**
 * Test-only SQL transport for a Cloudflare local Worker. The Worker never owns
 * a TCP socket; an isolated loopback bridge executes each query against the
 * disposable PostgreSQL instance and preserves explicit transaction sessions.
 */
export class P12PostgresHttpPool {
  private readonly config: P12PostgresBridgeConfig;

  constructor(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    if (!usesP12ContractAdapters(environment)) {
      throw new Error("P12 PostgreSQL bridge requires contract adapter mode");
    }
    this.config = readBridgeConfig(environment);
  }

  async query<Row extends object>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return await this.bridgeQuery<Row>(text, values);
  }

  async connect(): Promise<P12PostgresHttpClient> {
    const result = await this.request("connect", {});
    if (!result || typeof result !== "object" ||
      typeof (result as { sessionId?: unknown }).sessionId !== "string") {
      throw new Error("P12 PostgreSQL bridge returned an invalid session");
    }
    return new P12PostgresHttpClient(
      this,
      (result as { sessionId: string }).sessionId,
    );
  }

  async bridgeQuery<Row extends object>(
    text: string,
    values: readonly unknown[],
    sessionId?: string,
  ): Promise<QueryResult<Row>> {
    const result = decode(await this.request("query", {
      text,
      values,
      sessionId,
    })) as QueryResult<Row>;
    if (!result || !Array.isArray(result.rows)) {
      throw new Error("P12 PostgreSQL bridge returned an invalid query result");
    }
    return result;
  }

  async releaseSession(sessionId: string): Promise<void> {
    await this.request("release", { sessionId });
  }

  private async request(
    operation: "connect" | "query" | "release",
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation, ...body }),
    });
    const envelope = await response.json() as BridgeEnvelope;
    if (!response.ok) {
      throw new Error(envelope.error || "P12 PostgreSQL bridge request failed");
    }
    return envelope.result;
  }
}
