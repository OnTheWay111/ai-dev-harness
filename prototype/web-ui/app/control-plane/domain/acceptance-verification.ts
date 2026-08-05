import type { GoalAcceptanceCriterion } from "./goal-contract.ts";
import { canonicalJson, sha256Hex } from "./spec-artifact.ts";

export const acceptanceVerificationPlanDraftSchemaVersion =
  "acceptance-verification-plan-draft.v1" as const;
export const acceptanceVerificationPlanSchemaVersion =
  "acceptance-verification-plan.v1" as const;

export const verificationEnvironments = [
  "development",
  "test",
  "staging",
  "production",
] as const;
export type VerificationEnvironment =
  (typeof verificationEnvironments)[number];

export type VerificationStrategy =
  | { type: "command" | "query" | "artifact"; reference: string }
  | {
      type: "manual";
      instructions: string;
      requiredRole: "approver";
    };

export interface AcceptanceVerificationEntry {
  id: string;
  criterionRef: string;
  environment: VerificationEnvironment;
  strategy: VerificationStrategy;
  successCondition: string;
  timeoutMs: number;
  responsibleParty: string;
}

export interface AcceptanceVerificationPlanDraft {
  schemaVersion: typeof acceptanceVerificationPlanDraftSchemaVersion;
  entries: readonly AcceptanceVerificationEntry[];
}

export interface VerificationPlanCompilation {
  valid: true;
  coveredCriterionRefs: readonly string[];
}

export interface AcceptanceVerificationPlan {
  schemaVersion: typeof acceptanceVerificationPlanSchemaVersion;
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  goalVersion: number;
  issuePlanId: string;
  issuePlanVersion: number;
  revision: number;
  previousPlanId: string | null;
  entries: readonly AcceptanceVerificationEntry[];
  compilation: VerificationPlanCompilation;
  digest: string;
  compiledAt: string;
  version: number;
}

export interface VerificationReferenceCatalog {
  command: readonly string[];
  query: readonly string[];
  artifact: readonly string[];
}

export class AcceptanceVerificationPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptanceVerificationPlanValidationError";
  }
}

const textSchema = { type: "string", minLength: 1 } as const;
const closed = (
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
) => ({ type: "object", additionalProperties: false, required, properties });

const referencedStrategySchema = closed(
  ["type", "reference"],
  {
    type: { type: "string", enum: ["command", "query", "artifact"] },
    reference: textSchema,
  },
);
const manualStrategySchema = closed(
  ["type", "instructions", "requiredRole"],
  {
    type: { type: "string", const: "manual" },
    instructions: textSchema,
    requiredRole: { type: "string", const: "approver" },
  },
);

export const acceptanceVerificationPlanDraftOutputSchema = closed(
  ["schemaVersion", "entries"],
  {
    schemaVersion: {
      type: "string",
      const: acceptanceVerificationPlanDraftSchemaVersion,
    },
    entries: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: closed(
        [
          "id",
          "criterionRef",
          "environment",
          "strategy",
          "successCondition",
          "timeoutMs",
          "responsibleParty",
        ],
        {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,99}$" },
          criterionRef: textSchema,
          environment: { type: "string", enum: verificationEnvironments },
          strategy: { oneOf: [referencedStrategySchema, manualStrategySchema] },
          successCondition: textSchema,
          timeoutMs: { type: "integer", minimum: 1, maximum: 86_400_000 },
          responsibleParty: textSchema,
        },
      ),
    },
  },
);

function object(
  value: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AcceptanceVerificationPlanValidationError(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !keys.includes(key));
  const missing = keys.find((key) => !(key in record));
  if (unknown) {
    throw new AcceptanceVerificationPlanValidationError(
      `${name}.${unknown} is not allowed`,
    );
  }
  if (missing) {
    throw new AcceptanceVerificationPlanValidationError(
      `${name}.${missing} is required`,
    );
  }
  return record;
}

function boundedText(
  value: unknown,
  name: string,
  maximum = 2_000,
): string {
  if (typeof value !== "string" || !value.trim() ||
    value.trim().length > maximum) {
    throw new AcceptanceVerificationPlanValidationError(
      `${name} must be non-blank and bounded`,
    );
  }
  return value.trim();
}

function validateStrategy(value: unknown, name: string): VerificationStrategy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AcceptanceVerificationPlanValidationError(`${name} is invalid`);
  }
  const type = (value as { type?: unknown }).type;
  if (type === "manual") {
    const strategy = object(
      value,
      name,
      ["type", "instructions", "requiredRole"],
    );
    if (strategy.requiredRole !== "approver") {
      throw new AcceptanceVerificationPlanValidationError(
        `${name}.requiredRole must be approver`,
      );
    }
    return {
      type,
      instructions: boundedText(strategy.instructions, `${name}.instructions`, 4_000),
      requiredRole: "approver",
    };
  }
  if (!["command", "query", "artifact"].includes(String(type))) {
    throw new AcceptanceVerificationPlanValidationError(`${name}.type is invalid`);
  }
  const strategy = object(value, name, ["type", "reference"]);
  return {
    type: type as "command" | "query" | "artifact",
    reference: boundedText(strategy.reference, `${name}.reference`, 1_000),
  };
}

export function validateAcceptanceVerificationPlanDraft(
  value: unknown,
): AcceptanceVerificationPlanDraft {
  const record = object(value, "verificationPlan", ["schemaVersion", "entries"]);
  if (record.schemaVersion !== acceptanceVerificationPlanDraftSchemaVersion) {
    throw new AcceptanceVerificationPlanValidationError(
      `schemaVersion must be ${acceptanceVerificationPlanDraftSchemaVersion}`,
    );
  }
  if (!Array.isArray(record.entries) || record.entries.length < 1 ||
    record.entries.length > 50) {
    throw new AcceptanceVerificationPlanValidationError(
      "entries must be non-empty and bounded",
    );
  }
  const entries = record.entries.map((value, index) => {
    const name = `entries[${index}]`;
    const entry = object(value, name, [
      "id",
      "criterionRef",
      "environment",
      "strategy",
      "successCondition",
      "timeoutMs",
      "responsibleParty",
    ]);
    const id = boundedText(entry.id, `${name}.id`, 100);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new AcceptanceVerificationPlanValidationError(`${name}.id is invalid`);
    }
    if (!verificationEnvironments.includes(
      entry.environment as VerificationEnvironment,
    )) {
      throw new AcceptanceVerificationPlanValidationError(
        `${name}.environment is invalid`,
      );
    }
    const successCondition = boundedText(
      entry.successCondition,
      `${name}.successCondition`,
      2_000,
    );
    if (/^(looks? good|seems? (fine|done)|done)$/i.test(successCondition)) {
      throw new AcceptanceVerificationPlanValidationError(
        `${name}.successCondition must be deterministic`,
      );
    }
    if (!Number.isSafeInteger(entry.timeoutMs) ||
      (entry.timeoutMs as number) < 1 ||
      (entry.timeoutMs as number) > 86_400_000) {
      throw new AcceptanceVerificationPlanValidationError(
        `${name}.timeoutMs is invalid`,
      );
    }
    return {
      id,
      criterionRef: boundedText(entry.criterionRef, `${name}.criterionRef`, 200),
      environment: entry.environment as VerificationEnvironment,
      strategy: validateStrategy(entry.strategy, `${name}.strategy`),
      successCondition,
      timeoutMs: entry.timeoutMs as number,
      responsibleParty: boundedText(
        entry.responsibleParty,
        `${name}.responsibleParty`,
        200,
      ),
    };
  });
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new AcceptanceVerificationPlanValidationError("entry IDs must be unique");
  }
  return { schemaVersion: acceptanceVerificationPlanDraftSchemaVersion, entries };
}

export async function compileAcceptanceVerificationPlan(input: {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  goalVersion: number;
  issuePlanId: string;
  issuePlanVersion: number;
  revision: number;
  previousPlanId?: string | null;
  criteria: readonly GoalAcceptanceCriterion[];
  draft: unknown;
  availableReferences: VerificationReferenceCatalog;
  compiledAt: string;
}): Promise<AcceptanceVerificationPlan> {
  const draft = validateAcceptanceVerificationPlanDraft(input.draft);
  const expected = [...input.criteria.map(({ id }) => id)].sort();
  const actual = [...draft.entries.map(({ criterionRef }) => criterionRef)].sort();
  if (actual.length !== expected.length ||
    actual.some((reference, index) => reference !== expected[index])) {
    throw new AcceptanceVerificationPlanValidationError(
      "every AcceptanceCriterion must be covered exactly once",
    );
  }
  for (const entry of draft.entries) {
    if (entry.strategy.type === "manual") continue;
    if (!input.availableReferences[entry.strategy.type].includes(
      entry.strategy.reference,
    )) {
      throw new AcceptanceVerificationPlanValidationError(
        `unknown ${entry.strategy.type} reference ${entry.strategy.reference}`,
      );
    }
  }
  const base = {
    schemaVersion: acceptanceVerificationPlanSchemaVersion,
    id: input.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    goalId: input.goalId,
    goalVersion: input.goalVersion,
    issuePlanId: input.issuePlanId,
    issuePlanVersion: input.issuePlanVersion,
    revision: input.revision,
    previousPlanId: input.previousPlanId ?? null,
    entries: draft.entries,
    compilation: {
      valid: true as const,
      coveredCriterionRefs: input.criteria
        .slice()
        .sort((left, right) => left.position - right.position)
        .map(({ id }) => id),
    },
    compiledAt: input.compiledAt,
    version: 1,
  };
  return {
    ...base,
    digest: await sha256Hex(canonicalJson(base)),
  };
}
