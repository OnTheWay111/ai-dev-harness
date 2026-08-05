export type SupplyChainSeverity = "critical" | "high" | "moderate" | "low";
export type SupplyChainFindingKind =
  | "secret" | "vulnerability" | "license" | "image" | "build" | "provenance";

export interface SupplyChainFinding {
  id: string;
  component: string;
  kind: SupplyChainFindingKind;
  severity: SupplyChainSeverity;
}

export interface SupplyChainException {
  id: string;
  component: string;
  kind: SupplyChainFindingKind;
  owner: string;
  approvedBy: string;
  reason: string;
  scope: "internal-production-only";
  expiresAt: string;
  constraints: string[];
}

const OWNER = /^[a-z][a-z0-9-]{2,63}$/;
const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{2,199}$/;
const COMPONENT = /^[@A-Za-z0-9][A-Za-z0-9:_.@/-]{1,199}$/;
const KINDS = new Set<SupplyChainFindingKind>([
  "secret", "vulnerability", "license", "image", "build", "provenance",
]);
const SEVERITIES = new Set<SupplyChainSeverity>([
  "critical", "high", "moderate", "low",
]);
const REQUIRED_SURFACES = [
  "build-artifact", "container-image", "license", "provenance",
  "python-sca", "repository-secret", "sbom", "web-sca",
] as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function validateSupplyChainPolicy(value: unknown): void {
  const policy = object(value, "Supply-chain policy");
  const surfaces = policy.requiredSurfaces;
  if (policy.schemaVersion !== "harness.supply-chain-policy.v1" ||
    policy.environment !== "production" ||
    JSON.stringify(policy.blockSeverities) !== JSON.stringify(["critical", "high"]) ||
    !Array.isArray(surfaces) ||
    [...REQUIRED_SURFACES].some((surface) => !surfaces.includes(surface))) {
    throw new Error("Supply-chain policy identity or scan coverage is incomplete");
  }
  const exceptions = object(policy.exceptions, "Supply-chain exception policy");
  const image = object(policy.containerImage, "Container image policy");
  if (exceptions.requireOwner !== true || exceptions.requireExpiry !== true ||
    exceptions.maximumDays !== 90 || exceptions.secretsWaivable !== false ||
    image.currentStatus !== "not-applicable" ||
    image.failIfBuildDefinitionAppears !== true) {
    throw new Error("Supply-chain exception or image controls are incomplete");
  }
  const licenses = object(policy.licenses, "License policy");
  if (!Array.isArray(licenses.prohibited) ||
    !licenses.prohibited.includes("LicenseRef-Proprietary") ||
    !licenses.prohibited.includes("AGPL")) {
    throw new Error("Supply-chain prohibited license policy is incomplete");
  }
}

function parseException(raw: unknown, now: Date): SupplyChainException {
  const exception = object(raw, "Supply-chain exception");
  const expires = Date.parse(String(exception.expiresAt));
  if (!FINDING_ID.test(String(exception.id)) ||
    !COMPONENT.test(String(exception.component)) ||
    !KINDS.has(exception.kind as SupplyChainFindingKind) ||
    !OWNER.test(String(exception.owner)) ||
    !OWNER.test(String(exception.approvedBy)) ||
    typeof exception.reason !== "string" || exception.reason.trim().length < 20 ||
    exception.scope !== "internal-production-only" ||
    !Number.isFinite(expires) || expires <= now.getTime() ||
    expires - now.getTime() > 90 * 24 * 60 * 60 * 1_000 ||
    !Array.isArray(exception.constraints) || exception.constraints.length < 1 ||
    exception.constraints.some((item) => typeof item !== "string" || !item.trim())) {
    const failure = expires <= now.getTime() ? "expired" : "owner/approval/expiry";
    throw new Error(`Supply-chain exception ${failure} validation failed`);
  }
  return exception as unknown as SupplyChainException;
}

export function validateSupplyChainExceptions(
  value: unknown,
  now = new Date(),
): void {
  const document = object(value, "Supply-chain exception document");
  if (document.schemaVersion !== "harness.supply-chain-exceptions.v1" ||
    !Array.isArray(document.exceptions)) {
    throw new Error("Supply-chain exception document is invalid");
  }
  const ids = new Set<string>();
  for (const raw of document.exceptions) {
    const exception = parseException(raw, now);
    if (ids.has(exception.id)) throw new Error("Supply-chain exception ID is duplicated");
    ids.add(exception.id);
  }
}

function finding(raw: SupplyChainFinding): SupplyChainFinding {
  if (!FINDING_ID.test(raw.id) || !COMPONENT.test(raw.component) ||
    !KINDS.has(raw.kind) || !SEVERITIES.has(raw.severity)) {
    throw new Error("Supply-chain finding is invalid");
  }
  return { ...raw };
}

export function evaluateSupplyChainFindings(input: {
  findings: readonly SupplyChainFinding[];
  exceptions: readonly SupplyChainException[];
  now: string;
}): {
  allowed: boolean;
  blockers: SupplyChainFinding[];
  waived: SupplyChainFinding[];
  nonBlocking: SupplyChainFinding[];
} {
  const now = new Date(input.now);
  if (!Number.isFinite(now.getTime())) throw new Error("Supply-chain evaluation time is invalid");
  const validExceptions = new Map<string, SupplyChainException>();
  for (const raw of input.exceptions) {
    const exception = parseException(raw, now);
    validExceptions.set(exception.id, exception);
  }
  const blockers: SupplyChainFinding[] = [];
  const waived: SupplyChainFinding[] = [];
  const nonBlocking: SupplyChainFinding[] = [];
  for (const raw of input.findings) {
    const item = finding(raw);
    if (item.severity !== "critical" && item.severity !== "high") {
      nonBlocking.push(item);
      continue;
    }
    const exception = validExceptions.get(item.id);
    if (item.kind !== "secret" && exception &&
      exception.component === item.component && exception.kind === item.kind) {
      waived.push(item);
    } else {
      blockers.push(item);
    }
  }
  return { allowed: blockers.length === 0, blockers, waived, nonBlocking };
}
