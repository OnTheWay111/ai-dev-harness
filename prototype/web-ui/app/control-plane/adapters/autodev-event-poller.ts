import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  ExternalEventService,
  normalizeAutoDevRunEvent,
} from "../application/external-event-service.ts";

const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_EVENT_FILE_BYTES = 16 * 1024 * 1024;

export class AutoDevEventPoller {
  private readonly repositoryRoot: string;
  private readonly service: ExternalEventService;

  constructor(input: {
    repositoryRoot: string;
    service: ExternalEventService;
  }) {
    if (!input.repositoryRoot.startsWith("/") || input.repositoryRoot.includes("\0")) {
      throw new Error("AutoDev repository root must be absolute");
    }
    this.repositoryRoot = input.repositoryRoot;
    this.service = input.service;
  }

  async poll(input: {
    externalRunId: string;
    externalTaskId: string;
  }): Promise<{ observed: number; accepted: number }> {
    if (!EXTERNAL_ID.test(input.externalRunId) || !EXTERNAL_ID.test(input.externalTaskId)) {
      throw new Error("AutoDev poll identity is invalid");
    }
    const path = join(
      this.repositoryRoot,
      ".autodev",
      "runs",
      input.externalRunId,
      "events.jsonl",
    );
    let metadata;
    try {
      metadata = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { observed: 0, accepted: 0 };
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.size > MAX_EVENT_FILE_BYTES) {
      throw new Error("AutoDev event stream is unavailable or exceeds its bound");
    }
    const content = await readFile(path, "utf8");
    let observed = 0;
    let accepted = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      observed += 1;
      const raw = JSON.parse(line) as Record<string, unknown>;
      const result = await this.service.ingest(normalizeAutoDevRunEvent(
        raw,
        input.externalRunId,
        input.externalTaskId,
      ));
      if (result.disposition !== "duplicate") accepted += 1;
    }
    return { observed, accepted };
  }
}
