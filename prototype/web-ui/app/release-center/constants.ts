export const P12_PRODUCTION_GATE_IDS = [
  "browser-e2e",
  "identity-security",
  "autodev-authorization",
  "model-routing-write",
  "supply-chain",
  "git-traceability",
  "recovery-stop",
  "observability-oncall",
  "canary-goal-verification",
  "defect-budget",
] as const;

export const P12_RELEASE_SIGNATURE_ROLES = [
  "security",
  "operations",
  "product",
  "project-owner",
] as const;
