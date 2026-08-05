export interface ProductionRunbook {
  id: string;
  title: string;
  path: string;
  owner: string;
  escalation: string[];
  operations: string[];
}

export interface RunbookManifest {
  schemaVersion: string;
  environment: "production";
  requiredSections: string[];
  runbooks: ProductionRunbook[];
  drill: {
    scenario: string;
    minimumIndependentExecutions: number;
    receiptSchemaVersion: string;
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 ||
      value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value as string[];
}

export function validateRunbookManifest(value: unknown): asserts value is RunbookManifest {
  const manifest = record(value, "Runbook manifest");
  if (manifest.schemaVersion !== "harness.production-runbooks.v1" ||
      manifest.environment !== "production") {
    throw new Error("Runbook manifest schema or environment is invalid");
  }
  const requiredSections = strings(manifest.requiredSections, "requiredSections");
  const expectedSections = ["触发条件", "权限", "执行命令", "验证", "回退", "升级联系人"];
  if (requiredSections.join("\n") !== expectedSections.join("\n")) {
    throw new Error("Runbook requiredSections must use the production template");
  }
  if (!Array.isArray(manifest.runbooks) || manifest.runbooks.length < 1) {
    throw new Error("Runbook manifest must contain runbooks");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [index, item] of manifest.runbooks.entries()) {
    const runbook = record(item, `runbooks[${index}]`);
    for (const field of ["id", "title", "path", "owner"] as const) {
      if (typeof runbook[field] !== "string" || !runbook[field].trim()) {
        throw new Error(`runbooks[${index}].${field} is required`);
      }
    }
    const id = runbook.id as string;
    const path = runbook.path as string;
    if (!/^[a-z0-9-]+$/.test(id) || ids.has(id)) {
      throw new Error(`Runbook id is invalid or duplicated: ${id}`);
    }
    if (!/^docs\/runbooks\/[a-z0-9-]+\.md$/.test(path) || paths.has(path)) {
      throw new Error(`Runbook path is invalid or duplicated: ${path}`);
    }
    const escalation = strings(runbook.escalation,
      `runbooks[${index}].escalation`);
    if (!escalation.includes("incident-commander")) {
      throw new Error(`Runbook ${id} must escalate to incident-commander`);
    }
    strings(runbook.operations, `runbooks[${index}].operations`);
    ids.add(id);
    paths.add(path);
  }
  const drill = record(manifest.drill, "drill");
  if (drill.scenario !== "stop-and-worker-loss" ||
      drill.minimumIndependentExecutions !== 1 ||
      drill.receiptSchemaVersion !== "harness.runbook-drill.v1") {
    throw new Error("Runbook drill contract is invalid");
  }
}

function commandBlocks(document: string): string[] {
  return [...document.matchAll(/```(?:bash|sh)\s*\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? "");
}

function secretLiteralCount(commands: readonly string[]): number {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/gi,
    /\b(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*=\s*['"][^$<{\s][^'"]+['"]/gi,
  ];
  return commands.reduce((total, command) => total + patterns.reduce((count, pattern) => {
    pattern.lastIndex = 0;
    return count + [...command.matchAll(pattern)].length;
  }, 0), 0);
}

export function validateRunbookDocument(
  runbook: Pick<ProductionRunbook, "id" | "title" | "path" | "owner" | "escalation">,
  document: string,
  requiredSections: readonly string[],
): { commandBlocks: number; secretLiteralCount: number } {
  if (!document.startsWith("# ")) throw new Error(`${runbook.id} is missing a title`);
  const missing = requiredSections.filter((section) =>
    !new RegExp(`^## ${section}$`, "m").test(document));
  const blocks = commandBlocks(document);
  const secrets = secretLiteralCount(blocks);
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing sections: ${missing.join(", ")}`);
  if (blocks.length < 1) problems.push("missing copyable command block");
  if (secrets > 0) problems.push("command contains a Secret literal");
  if (/git\s+(?:reset\s+--hard|push\s+--force)|rm\s+-rf/.test(blocks.join("\n"))) {
    problems.push("command contains a destructive operation");
  }
  if (!document.includes(`Owner：\`${runbook.owner}\``)) {
    problems.push("document owner does not match the manifest");
  }
  for (const contact of runbook.escalation) {
    if (!document.includes(`\`${contact}\``)) {
      problems.push(`missing escalation contact: ${contact}`);
    }
  }
  if (problems.length > 0) throw new Error(`${runbook.id}: ${problems.join("; ")}`);
  return { commandBlocks: blocks.length, secretLiteralCount: secrets };
}

export function validateRunbookDrillReceipt(value: unknown): void {
  const receipt = record(value, "Runbook drill receipt");
  if (receipt.schemaVersion !== "harness.runbook-drill.v1" ||
      receipt.scenario !== "stop-and-worker-loss" || receipt.result !== "passed" ||
      receipt.mode !== "isolated-control-plane-real-code-path") {
    throw new Error("Runbook drill receipt identity or result is invalid");
  }
  const executor = record(receipt.executor, "Runbook drill executor");
  if (executor.independent !== true || typeof executor.authorRole !== "string" ||
      typeof executor.executorRole !== "string" ||
      executor.authorRole === executor.executorRole ||
      executor.inputScope !== "runbook-and-manifest-only") {
    throw new Error("Runbook drill executor is not independent");
  }
  const assertions = record(receipt.assertions, "Runbook drill assertions");
  if (Object.keys(assertions).length < 7 ||
      Object.values(assertions).some((item) => item !== true)) {
    throw new Error("Runbook drill assertions are incomplete or failed");
  }
  strings(receipt.revisions, "Runbook drill revisions");
  if (!Array.isArray(receipt.gaps) || receipt.gaps.length !== 0) {
    throw new Error("Runbook drill has unresolved gaps");
  }
  const evidence = record(receipt.evidence, "Runbook drill evidence");
  for (const field of ["manifestSha256", "runbookSha256"]) {
    if (typeof evidence[field] !== "string" ||
        !/^[0-9a-f]{64}$/.test(evidence[field] as string)) {
      throw new Error(`Runbook drill ${field} is invalid`);
    }
  }
  if (typeof receipt.durationSeconds !== "number" || receipt.durationSeconds < 0 ||
      Number.isNaN(new Date(receipt.startedAt as string).getTime()) ||
      Number.isNaN(new Date(receipt.completedAt as string).getTime())) {
    throw new Error("Runbook drill timing is invalid");
  }
}
