import type {
  ArtifactEvidenceRecord,
  ArtifactKind,
} from "../domain/artifact-evidence.ts";
import { artifactKinds } from "../domain/artifact-evidence.ts";
import type { EvidenceRepository } from
  "../ports/evidence-repository.ts";
import type {
  ArtifactRetentionPolicy,
  ObjectStorePort,
} from "../ports/object-store-port.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const TEXT_MEDIA_TYPE = /^(text\/|application\/(?:json|.+\+json|xml|.+\+xml|yaml|x-yaml))/i;

export class ArtifactIngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactIngestionError";
  }
}

export interface ArtifactIngestionInput {
  organizationId: string;
  projectId: string;
  goalId: string;
  issueId: string;
  runId: string;
  kind: ArtifactKind;
  mediaType: string;
  source: AsyncIterable<Uint8Array>;
  createdBy: string;
  secretValues?: readonly string[];
  identityValues?: readonly string[];
  retentionPolicy: ArtifactRetentionPolicy;
  expectedDigest?: string;
  captureRaw?: boolean;
  rawCaptureAuthorized?: boolean;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redact(
  text: string,
  secrets: readonly string[],
  identities: readonly string[],
): string {
  let value = text;
  for (const secret of [...new Set(secrets)].filter((item) => item.length > 0)) {
    value = value.replace(new RegExp(escapePattern(secret), "g"), "[REDACTED]");
  }
  for (const identity of [...new Set(identities)].filter((item) => item.length > 0)) {
    value = value.replace(
      new RegExp(escapePattern(identity), "gi"),
      "[REDACTED_IDENTITY]",
    );
  }
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(?:postgres(?:ql)?|mysql|redis):\/\/[^\s'\"]+/gi, "[REDACTED_CONNECTION_URL]")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/g, "[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_IDENTITY]")
    .replace(/\/(?:Users|home)\/[^\s/]+(?:\/[^\s]*)?/g, "[REDACTED_PATH]")
    .replace(/[A-Za-z]:\\Users\\[^\s\\]+(?:\\[^\s]*)?/g, "[REDACTED_PATH]")
    .replace(/\/tmp\/(?:ai-dev-execution|autodev-worktree)-[^\s]*/g, "[REDACTED_PATH]");
}

function retentionUntil(policy: ArtifactRetentionPolicy, now: Date): string {
  const days = policy === "standard_180d"
    ? 180
    : policy === "extended_365d"
    ? 365
    : 36_500;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1_000).toISOString();
}

async function sanitizedBytes(input: ArtifactIngestionInput, options: {
  maxTextBytes: number;
  maxInputBytes: number;
}): Promise<Uint8Array> {
  if (!TEXT_MEDIA_TYPE.test(input.mediaType)) {
    throw new ArtifactIngestionError(
      "Binary evidence is rejected; upload a bounded textual summary instead",
    );
  }
  const secrets = input.secretValues ?? [];
  const identities = input.identityValues ?? [];
  const lookahead = Math.min(
    8_192,
    Math.max(1_024, ...secrets.map((value) => value.length)),
  );
  const retained: Uint8Array[] = [];
  let retainedBytes = 0;
  let inputBytes = 0;
  const retainLimit = options.maxTextBytes + lookahead;
  for await (const value of input.source) {
    const chunk = new Uint8Array(value);
    inputBytes += chunk.byteLength;
    if (inputBytes > options.maxInputBytes) {
      throw new ArtifactIngestionError("Artifact input exceeds the hard safety limit");
    }
    if (retainedBytes < retainLimit) {
      const remaining = retainLimit - retainedBytes;
      const selected = chunk.subarray(0, remaining);
      retained.push(selected);
      retainedBytes += selected.byteLength;
    }
  }
  const combined = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of retained) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (combined.includes(0)) {
    throw new ArtifactIngestionError("Binary artifact content is not accepted");
  }
  let text = new TextDecoder("utf-8", { fatal: false }).decode(combined);
  text = redact(text, secrets, identities);
  if (new TextEncoder().encode(text).byteLength > options.maxTextBytes ||
    inputBytes > options.maxTextBytes) {
    const marker = `\n[TRUNCATED: original ${inputBytes} bytes]`;
    const contentBudget = options.maxTextBytes -
      new TextEncoder().encode(marker).byteLength;
    while (new TextEncoder().encode(text).byteLength > contentBudget) {
      text = text.slice(0, Math.max(0, text.length - 64));
    }
    text += marker;
  }
  return new TextEncoder().encode(text);
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export class ArtifactIngestionService {
  private readonly objectStore: ObjectStorePort;
  private readonly repository: EvidenceRepository;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly maxTextBytes: number;
  private readonly maxInputBytes: number;
  private readonly allowRawCapture: boolean;

  constructor(input: {
    objectStore: ObjectStorePort;
    repository: EvidenceRepository;
    clock?: () => Date;
    idFactory?: () => string;
    maxTextBytes?: number;
    maxInputBytes?: number;
    allowRawCapture?: boolean;
  }) {
    this.objectStore = input.objectStore;
    this.repository = input.repository;
    this.clock = input.clock ?? (() => new Date());
    this.idFactory = input.idFactory ?? (() => crypto.randomUUID());
    this.maxTextBytes = input.maxTextBytes ?? 8 * 1024 * 1024;
    this.maxInputBytes = input.maxInputBytes ?? 64 * 1024 * 1024;
    this.allowRawCapture = input.allowRawCapture ?? false;
    if (!Number.isSafeInteger(this.maxTextBytes) || this.maxTextBytes < 64 ||
      !Number.isSafeInteger(this.maxInputBytes) ||
      this.maxInputBytes < this.maxTextBytes) {
      throw new ArtifactIngestionError("Artifact size limits are invalid");
    }
  }

  async ingest(input: ArtifactIngestionInput): Promise<ArtifactEvidenceRecord> {
    if (!artifactKinds.includes(input.kind) || !input.createdBy.trim()) {
      throw new ArtifactIngestionError("Artifact identity is invalid");
    }
    if (input.expectedDigest && !SHA256.test(input.expectedDigest)) {
      throw new ArtifactIngestionError("Expected artifact digest is invalid");
    }
    if (input.captureRaw &&
      (!this.allowRawCapture || !input.rawCaptureAuthorized)) {
      throw new ArtifactIngestionError("Raw capture is disabled by policy");
    }
    const now = this.clock();
    const bytes = input.captureRaw
      ? await sanitizedBytes({ ...input, secretValues: [], identityValues: [] }, {
          maxTextBytes: this.maxTextBytes,
          maxInputBytes: this.maxInputBytes,
        })
      : await sanitizedBytes(input, {
          maxTextBytes: this.maxTextBytes,
          maxInputBytes: this.maxInputBytes,
        });
    const retention = retentionUntil(input.retentionPolicy, now);
    const object = await this.objectStore.putImmutable({
      scope: {
        organizationId: input.organizationId,
        projectId: input.projectId,
      },
      body: oneChunk(bytes),
      expectedDigest: input.expectedDigest,
      mediaType: input.mediaType,
      maxBytes: bytes.byteLength + 1,
      createdAt: now.toISOString(),
      createdBy: input.createdBy,
      retentionPolicy: input.retentionPolicy,
      retentionUntil: retention,
    });
    return await this.repository.saveArtifact({
      id: this.idFactory(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      goalId: input.goalId,
      issueId: input.issueId,
      runId: input.runId,
      kind: input.kind,
      objectKey: object.objectKey,
      digest: object.digest,
      mediaType: object.mediaType,
      sizeBytes: object.sizeBytes,
      createdBy: input.createdBy,
      retentionPolicy: input.retentionPolicy,
      retentionUntil: retention,
      createdAt: now.toISOString(),
    });
  }
}
