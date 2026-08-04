import type { IssueDraft } from "./issue-plan.ts";

export const modelRouterPolicyRevision = "model-router.v1" as const;
export const capabilityTiers = [
  "cost_optimized",
  "general_coding",
  "advanced_coding",
  "frontier",
] as const;
export const reasoningEfforts = ["low", "medium", "high", "highest"] as const;
export type CapabilityTier = (typeof capabilityTiers)[number];
export type ReasoningEffort = (typeof reasoningEfforts)[number];

export interface ModelRoutingFactors {
  risk: "low" | "medium" | "high";
  codeScope: "narrow" | "broad" | "extensive";
  domainComplexity: "standard" | "complex";
  verificationDifficulty: "standard" | "complex";
}

export interface ModelRouteOverride {
  capabilityTier: CapabilityTier;
  reasoningEffort: ReasoningEffort;
  actorId: string;
  reason: string;
  overriddenAt: string;
}

export interface ModelRecommendation {
  issueKey: string;
  capabilityTier: CapabilityTier;
  reasoningEffort: ReasoningEffort;
  policyRevision: typeof modelRouterPolicyRevision;
  factors: ModelRoutingFactors;
  reasons: readonly string[];
  override: ModelRouteOverride | null;
}

export class ModelRouteUnavailableError extends Error {
  constructor(message = "No allowed model capability can satisfy the approved route") {
    super(message);
    this.name = "ModelRouteUnavailableError";
  }
}

function factors(issue: IssueDraft): ModelRoutingFactors {
  const riskyText = `${issue.title} ${issue.goal} ${issue.requirementRefs.join(" ")}`;
  const resourceRisk = issue.conflictResources.databaseObjects.length > 0 ||
    issue.conflictResources.sharedConfigurations.length > 0 ||
    issue.conflictResources.landingOrder.length > 0;
  const securityRisk = /security|auth|credential|permission|migration|secret|token/i.test(riskyText);
  const publicRisk = issue.conflictResources.publicInterfaces.length > 0;
  const risk = (resourceRisk && (securityRisk || publicRisk))
    ? "high" as const
    : resourceRisk || securityRisk || publicRisk
    ? "medium" as const
    : "low" as const;
  const codeScope = issue.expectedFiles.length > 10
    ? "extensive" as const
    : issue.expectedFiles.length > 3
    ? "broad" as const
    : "narrow" as const;
  const domainComplexity = issue.requirementRefs.length > 2 ||
      issue.dependencyCandidates.length > 1 ||
      issue.conflictResources.publicInterfaces.length > 1
    ? "complex" as const
    : "standard" as const;
  const verificationDifficulty = issue.verify.length > 2 || issue.acceptance.length > 3 ||
      issue.completionEvidence.length > 3
    ? "complex" as const
    : "standard" as const;
  return { risk, codeScope, domainComplexity, verificationDifficulty };
}

export function recommendModelRoute(issue: IssueDraft): ModelRecommendation {
  const input = factors(issue);
  const score = (input.risk === "high" ? 4 : input.risk === "medium" ? 2 : 0) +
    (input.codeScope === "extensive" ? 3 : input.codeScope === "broad" ? 1 : 0) +
    (input.domainComplexity === "complex" ? 2 : 0) +
    (input.verificationDifficulty === "complex" ? 2 : 0) +
    (input.risk === "high" && input.codeScope === "extensive" ? 1 : 0);
  const [capabilityTier, reasoningEffort] = score >= 8
    ? ["frontier", "highest"] as const
    : score >= 5
    ? ["advanced_coding", "high"] as const
    : score >= 2
    ? ["general_coding", "medium"] as const
    : ["cost_optimized", "low"] as const;
  return {
    issueKey: issue.key,
    capabilityTier,
    reasoningEffort,
    policyRevision: modelRouterPolicyRevision,
    factors: input,
    reasons: [
      `risk=${input.risk}`,
      `codeScope=${input.codeScope} (${issue.expectedFiles.length} expected files)`,
      `domainComplexity=${input.domainComplexity}`,
      `verificationDifficulty=${input.verificationDifficulty}`,
      `policy score=${score}`,
    ],
    override: null,
  };
}

export function assertRouteAvailable(
  recommendation: ModelRecommendation,
  available: {
    capabilityTiers: readonly CapabilityTier[];
    reasoningEfforts: readonly ReasoningEffort[];
  },
): void {
  if (!available.capabilityTiers.includes(recommendation.capabilityTier) ||
    !available.reasoningEfforts.includes(recommendation.reasoningEffort)) {
    throw new ModelRouteUnavailableError(
      `Required ${recommendation.capabilityTier}/${recommendation.reasoningEffort} route is unavailable; silent downgrade is forbidden`,
    );
  }
}

function nonBlank(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 4_000) {
    throw new Error(`${name} must be a non-blank bounded value`);
  }
  return value.trim();
}

export function withModelRouteOverride(
  recommendation: ModelRecommendation,
  override: ModelRouteOverride,
): ModelRecommendation {
  nonBlank(override.actorId, "actorId");
  const reason = nonBlank(override.reason, "reason");
  if (!capabilityTiers.includes(override.capabilityTier) ||
    !reasoningEfforts.includes(override.reasoningEffort) ||
    Number.isNaN(new Date(override.overriddenAt).getTime())) {
    throw new Error("model route override is invalid");
  }
  if (recommendation.factors.risk === "high" && (
    capabilityTiers.indexOf(override.capabilityTier) < capabilityTiers.indexOf(recommendation.capabilityTier) ||
    reasoningEfforts.indexOf(override.reasoningEffort) < reasoningEfforts.indexOf(recommendation.reasoningEffort)
  )) {
    throw new ModelRouteUnavailableError("High-risk routes cannot be downgraded by override");
  }
  return {
    ...recommendation,
    capabilityTier: override.capabilityTier,
    reasoningEffort: override.reasoningEffort,
    override: { ...override, actorId: override.actorId.trim(), reason },
  };
}
