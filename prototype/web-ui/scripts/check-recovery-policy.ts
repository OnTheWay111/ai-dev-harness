import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  validateRecoveryPolicy,
  validateRecoveryProviderEvidence,
} from "../app/reliability/recovery-policy.ts";

async function json(path: URL | string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main(): Promise<void> {
  const policyPath = new URL(
    "../../../ops/production/recovery-policy.json",
    import.meta.url,
  );
  validateRecoveryPolicy(await json(policyPath));
  if (process.env.RECOVERY_REQUIRE_PROVIDER_EVIDENCE === "true") {
    const evidencePath = process.env.RECOVERY_PROVIDER_EVIDENCE_PATH?.trim();
    if (!evidencePath || !isAbsolute(evidencePath)) {
      throw new Error("Absolute RECOVERY_PROVIDER_EVIDENCE_PATH is required");
    }
    validateRecoveryProviderEvidence(await json(evidencePath));
  }
  console.log("P11 recovery policy and requested provider evidence passed");
}

main().catch(() => {
  console.error("P11 recovery policy check failed; provider details were suppressed");
  process.exitCode = 1;
});
