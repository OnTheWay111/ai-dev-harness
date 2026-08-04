import type { ArtifactIngestionService } from
  "../application/artifact-ingestion-service.ts";
import type { ExecutionArtifactSink } from
  "../ports/execution-artifact-port.ts";

async function* content(value: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(value);
}

export class ArtifactIngestionExecutionSink implements ExecutionArtifactSink {
  private readonly service: ArtifactIngestionService;

  constructor(service: ArtifactIngestionService) {
    this.service = service;
  }

  async capture(
    input: Parameters<ExecutionArtifactSink["capture"]>[0],
  ): Promise<void> {
    await this.service.ingest({
      ...input.context,
      kind: input.kind,
      mediaType: input.mediaType,
      source: content(input.content),
      createdBy: input.createdBy,
      secretValues: input.secretValues,
      retentionPolicy: "standard_180d",
    });
  }
}
