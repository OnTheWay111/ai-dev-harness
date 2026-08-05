import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  evaluateSupplyChainFindings,
  type SupplyChainException,
  type SupplyChainFinding,
  validateSupplyChainExceptions,
  validateSupplyChainPolicy,
} from "../app/security/supply-chain-policy.ts";

const repositoryRoot = new URL("../../../", import.meta.url);
const webRoot = new URL("../", import.meta.url);
const policyUrl = new URL(
  "../../../ops/production/supply-chain-policy.json",
  import.meta.url,
);
const exceptionsUrl = new URL(
  "../../../ops/production/supply-chain-exceptions.json",
  import.meta.url,
);

async function json(path: URL): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function installedPackages(
  directory: string,
  packages = new Map<string, { name: string; version: string; license?: string }>(),
): Promise<typeof packages> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      await installedPackages(path, packages);
      continue;
    }
    try {
      const metadata = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
      if (typeof metadata.name === "string" && typeof metadata.version === "string") {
        packages.set(`${metadata.name}@${metadata.version}`, {
          name: metadata.name,
          version: metadata.version,
          license: typeof metadata.license === "string" ? metadata.license : undefined,
        });
      }
    } catch {
      continue;
    }
    try {
      await installedPackages(join(path, "node_modules"), packages);
    } catch {
      // Most packages do not have nested dependencies.
    }
  }
  return packages;
}

function prohibitedLicense(value: string | undefined): string | undefined {
  if (!value) return "UNLICENSED";
  const normalized = value.toUpperCase();
  if (normalized.includes("LICENSEREF-PROPRIETARY")) return "LicenseRef-Proprietary";
  if (normalized.includes("AGPL")) return "AGPL";
  if (normalized.includes("SSPL")) return "SSPL";
  if (/(^|[^L])GPL(?:-|\b)/.test(normalized)) return "GPL";
  if (normalized.includes("UNLICENSED")) return "UNLICENSED";
  return undefined;
}

async function buildDefinitions(
  directory: string,
  found: string[] = [],
): Promise<string[]> {
  const excluded = new Set([
    ".git", ".next", ".venv", "dist", "node_modules", "__pycache__",
  ]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name)) await buildDefinitions(join(directory, entry.name), found);
      continue;
    }
    const name = entry.name.toLowerCase();
    if (name === "dockerfile" || name === "containerfile" ||
      name.endsWith(".dockerfile")) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

async function main(): Promise<void> {
  const policy = await json(policyUrl);
  const exceptionDocument = await json(exceptionsUrl) as {
    exceptions: SupplyChainException[];
  };
  validateSupplyChainPolicy(policy);
  validateSupplyChainExceptions(exceptionDocument);
  const packages = await installedPackages(join(webRoot.pathname, "node_modules"));
  if (packages.size < 1) throw new Error("Locked Web dependencies are not installed");
  const findings: SupplyChainFinding[] = [];
  for (const value of packages.values()) {
    const violation = prohibitedLicense(value.license);
    if (violation) {
      findings.push({
        id: `license:${value.name}:${violation}`,
        component: value.name,
        kind: "license",
        severity: "high",
      });
    }
  }
  findings.push({
    id: "license:autodev-harness:LicenseRef-Proprietary",
    component: "autodev-harness",
    kind: "license",
    severity: "high",
  });
  const definitions = await buildDefinitions(repositoryRoot.pathname);
  if (definitions.length > 0) {
    findings.push({
      id: "image:unconfigured-build-definition",
      component: basename(definitions[0]),
      kind: "image",
      severity: "high",
    });
  }
  const result = evaluateSupplyChainFindings({
    findings,
    exceptions: exceptionDocument.exceptions,
    now: new Date().toISOString(),
  });
  if (!result.allowed) {
    throw new Error(`Supply-chain policy has ${result.blockers.length} blocker(s)`);
  }
  console.log(JSON.stringify({
    schemaVersion: "harness.supply-chain-check.v1",
    packageCount: packages.size,
    containerImage: definitions.length === 0 ? "not-applicable" : "required",
    waived: result.waived.map((item) => item.id),
    blockerCount: result.blockers.length,
    result: "passed",
  }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Supply-chain check failed";
  console.error(message.replace(/\/(?:Users|home)\/[^\s]+/g, "[REDACTED_PATH]"));
  process.exitCode = 1;
});
