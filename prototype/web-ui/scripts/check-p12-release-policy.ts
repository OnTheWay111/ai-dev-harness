import { readFile } from "node:fs/promises";

import { P12_CANARY_MINIMUM_HOURS } from
  "../app/reliability/p12-canary-gate.ts";
import {
  P12_PRODUCTION_GATE_IDS,
  P12_RELEASE_SIGNATURE_ROLES,
} from "../app/reliability/p12-production-release-gate.ts";

const policyUrl = new URL(
  "../../../ops/production/p12-release-policy.json",
  import.meta.url,
);

async function main(): Promise<void> {
  const policy = JSON.parse(await readFile(policyUrl, "utf8"));
  if (policy.schemaVersion !== "harness.p12-release-policy.v1" ||
      policy.canary?.minimumContinuousHours !== P12_CANARY_MINIMUM_HOURS ||
      JSON.stringify(policy.productionGates) !== JSON.stringify(P12_PRODUCTION_GATE_IDS) ||
      JSON.stringify(policy.signatureRoles) !== JSON.stringify(P12_RELEASE_SIGNATURE_ROLES) ||
      policy.signature?.authenticationMethod !== "oidc" ||
      policy.signature?.bindsCanonicalEvidenceDigest !== true ||
      policy.signature?.requiresAuditReceipt !== true ||
      policy.signature?.distinctSignerPerRole !== true ||
      policy.defects?.p0Maximum !== 0 || policy.defects?.p1Maximum !== 0 ||
      policy.defects?.p2RequiresOwner !== true ||
      policy.defects?.p2RequiresWorkaround !== true) {
    throw new Error("P12 release policy does not match the executable gate");
  }
  console.log(JSON.stringify({
    schemaVersion: policy.schemaVersion,
    minimumContinuousHours: P12_CANARY_MINIMUM_HOURS,
    gateCount: P12_PRODUCTION_GATE_IDS.length,
    signatureRoleCount: P12_RELEASE_SIGNATURE_ROLES.length,
    result: "passed",
  }));
}

main().catch(() => {
  console.error("P12 release policy validation failed");
  process.exitCode = 1;
});
