import type { SpecRevisionStatus } from "./state-machines.ts";

export const specBundleSchemaVersion = "spec-bundle.v1" as const;

export type EstimatedCost = "low" | "medium" | "high";
export type SolutionElementKind =
  | "architecture"
  | "migration"
  | "product"
  | "rollback";

export interface SpecRequirement {
  id: string;
  statement: string;
  acceptanceCriterionRefs: readonly string[];
}

export interface SpecSolutionElement {
  id: string;
  title: string;
  kind: SolutionElementKind;
  description: string;
  acceptanceCriterionRefs: readonly string[];
  constraintRefs: readonly string[];
  estimatedCost: EstimatedCost;
  removalImpact: string;
  evidence: readonly string[];
}

export interface SpecBundle {
  schemaVersion: typeof specBundleSchemaVersion;
  proposal: {
    summary: string;
    value: string;
    inScope: readonly string[];
    outOfScope: readonly string[];
    deliverySlices: readonly string[];
  };
  prd: {
    problem: string;
    users: readonly string[];
    requirements: readonly SpecRequirement[];
    nonGoals: readonly string[];
    constraints: readonly string[];
  };
  architecture: {
    summary: string;
    components: readonly {
      id: string;
      name: string;
      responsibility: string;
      requirementRefs: readonly string[];
    }[];
    decisions: readonly string[];
  };
  migration: {
    required: boolean;
    steps: readonly string[];
    verification: readonly string[];
  };
  rollback: {
    triggers: readonly string[];
    steps: readonly string[];
    dataRecovery: string;
  };
  solutionElements: readonly SpecSolutionElement[];
}

export interface PlannerConfiguration {
  adapter: string;
  modelProfile: string;
  schemaVersion: typeof specBundleSchemaVersion;
}

export interface SpecRevision {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  revision: number;
  previousRevisionId: string | null;
  status: SpecRevisionStatus;
  sourceGoalVersion: number;
  artifactRef: string;
  artifactDigest: string;
  artifactMediaType: "application/json";
  artifactSizeBytes: number;
  plannerRunId: string;
  plannerConfiguration: PlannerConfiguration;
  generatedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SpecRevisionTimeline {
  revisions: readonly SpecRevision[];
}

export class SpecBundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecBundleValidationError";
  }
}

const text = { type: "string", minLength: 1 } as const;
const texts = { type: "array", items: text } as const;
const closed = (
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
) => ({ type: "object", additionalProperties: false, required, properties });

export const specBundleOutputSchema = closed(
  [
    "schemaVersion",
    "proposal",
    "prd",
    "architecture",
    "migration",
    "rollback",
    "solutionElements",
  ],
  {
    schemaVersion: { type: "string", const: specBundleSchemaVersion },
    proposal: closed(
      ["summary", "value", "inScope", "outOfScope", "deliverySlices"],
      { summary: text, value: text, inScope: texts, outOfScope: texts, deliverySlices: texts },
    ),
    prd: closed(
      ["problem", "users", "requirements", "nonGoals", "constraints"],
      {
        problem: text,
        users: texts,
        requirements: {
          type: "array",
          items: closed(
            ["id", "statement", "acceptanceCriterionRefs"],
            { id: text, statement: text, acceptanceCriterionRefs: texts },
          ),
        },
        nonGoals: texts,
        constraints: texts,
      },
    ),
    architecture: closed(
      ["summary", "components", "decisions"],
      {
        summary: text,
        components: {
          type: "array",
          items: closed(
            ["id", "name", "responsibility", "requirementRefs"],
            { id: text, name: text, responsibility: text, requirementRefs: texts },
          ),
        },
        decisions: texts,
      },
    ),
    migration: closed(
      ["required", "steps", "verification"],
      { required: { type: "boolean" }, steps: texts, verification: texts },
    ),
    rollback: closed(
      ["triggers", "steps", "dataRecovery"],
      { triggers: texts, steps: texts, dataRecovery: text },
    ),
    solutionElements: {
      type: "array",
      items: closed(
        [
          "id",
          "title",
          "kind",
          "description",
          "acceptanceCriterionRefs",
          "constraintRefs",
          "estimatedCost",
          "removalImpact",
          "evidence",
        ],
        {
          id: text,
          title: text,
          kind: { enum: ["architecture", "migration", "product", "rollback"] },
          description: text,
          acceptanceCriterionRefs: texts,
          constraintRefs: texts,
          estimatedCost: { enum: ["low", "medium", "high"] },
          removalImpact: text,
          evidence: texts,
        },
      ),
    },
  },
);

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SpecBundleValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SpecBundleValidationError(`${path} contains missing or unknown fields`);
  }
}

function boundedText(value: unknown, path: string, maximum = 20_000): string {
  if (typeof value !== "string") throw new SpecBundleValidationError(`${path} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new SpecBundleValidationError(`${path} must be non-blank and bounded`);
  }
  return normalized;
}

function textList(
  value: unknown,
  path: string,
  options: { minimum?: number; maximum?: number } = {},
): string[] {
  if (!Array.isArray(value)) throw new SpecBundleValidationError(`${path} must be a list`);
  if (value.length < (options.minimum ?? 0) || value.length > (options.maximum ?? 100)) {
    throw new SpecBundleValidationError(`${path} has an invalid item count`);
  }
  const normalized = value.map((item, index) => boundedText(item, `${path}[${index}]`, 4_000));
  if (new Set(normalized).size !== normalized.length) {
    throw new SpecBundleValidationError(`${path} contains duplicates`);
  }
  return normalized;
}

function ensureIds(values: readonly { id: string }[], path: string): void {
  if (new Set(values.map(({ id }) => id)).size !== values.length) {
    throw new SpecBundleValidationError(`${path} contains duplicate ids`);
  }
}

export function validateSpecBundle(value: unknown): SpecBundle {
  const root = record(value, "spec");
  exactKeys(root, ["schemaVersion", "proposal", "prd", "architecture", "migration", "rollback", "solutionElements"], "spec");
  if (root.schemaVersion !== specBundleSchemaVersion) {
    throw new SpecBundleValidationError("spec.schemaVersion is unsupported");
  }

  const proposal = record(root.proposal, "spec.proposal");
  exactKeys(proposal, ["summary", "value", "inScope", "outOfScope", "deliverySlices"], "spec.proposal");
  const prd = record(root.prd, "spec.prd");
  exactKeys(prd, ["problem", "users", "requirements", "nonGoals", "constraints"], "spec.prd");
  if (!Array.isArray(prd.requirements)) {
    throw new SpecBundleValidationError("spec.prd.requirements must be a list");
  }
  const requirements = prd.requirements.map((item, index) => {
    const requirement = record(item, `spec.prd.requirements[${index}]`);
    exactKeys(requirement, ["id", "statement", "acceptanceCriterionRefs"], `spec.prd.requirements[${index}]`);
    return {
      id: boundedText(requirement.id, `spec.prd.requirements[${index}].id`, 64),
      statement: boundedText(requirement.statement, `spec.prd.requirements[${index}].statement`, 4_000),
      acceptanceCriterionRefs: textList(requirement.acceptanceCriterionRefs, `spec.prd.requirements[${index}].acceptanceCriterionRefs`, { minimum: 1 }),
    };
  });
  ensureIds(requirements, "spec.prd.requirements");

  const architecture = record(root.architecture, "spec.architecture");
  exactKeys(architecture, ["summary", "components", "decisions"], "spec.architecture");
  if (!Array.isArray(architecture.components)) {
    throw new SpecBundleValidationError("spec.architecture.components must be a list");
  }
  const components = architecture.components.map((item, index) => {
    const component = record(item, `spec.architecture.components[${index}]`);
    exactKeys(component, ["id", "name", "responsibility", "requirementRefs"], `spec.architecture.components[${index}]`);
    return {
      id: boundedText(component.id, `spec.architecture.components[${index}].id`, 64),
      name: boundedText(component.name, `spec.architecture.components[${index}].name`, 200),
      responsibility: boundedText(component.responsibility, `spec.architecture.components[${index}].responsibility`, 4_000),
      requirementRefs: textList(component.requirementRefs, `spec.architecture.components[${index}].requirementRefs`, { minimum: 1 }),
    };
  });
  ensureIds(components, "spec.architecture.components");

  const migration = record(root.migration, "spec.migration");
  exactKeys(migration, ["required", "steps", "verification"], "spec.migration");
  if (typeof migration.required !== "boolean") {
    throw new SpecBundleValidationError("spec.migration.required must be boolean");
  }
  const rollback = record(root.rollback, "spec.rollback");
  exactKeys(rollback, ["triggers", "steps", "dataRecovery"], "spec.rollback");
  if (!Array.isArray(root.solutionElements)) {
    throw new SpecBundleValidationError("spec.solutionElements must be a list");
  }
  const solutionElements = root.solutionElements.map((item, index) => {
    const element = record(item, `spec.solutionElements[${index}]`);
    exactKeys(element, ["id", "title", "kind", "description", "acceptanceCriterionRefs", "constraintRefs", "estimatedCost", "removalImpact", "evidence"], `spec.solutionElements[${index}]`);
    if (!["architecture", "migration", "product", "rollback"].includes(String(element.kind))) {
      throw new SpecBundleValidationError(`spec.solutionElements[${index}].kind is invalid`);
    }
    if (!["low", "medium", "high"].includes(String(element.estimatedCost))) {
      throw new SpecBundleValidationError(`spec.solutionElements[${index}].estimatedCost is invalid`);
    }
    return {
      id: boundedText(element.id, `spec.solutionElements[${index}].id`, 64),
      title: boundedText(element.title, `spec.solutionElements[${index}].title`, 300),
      kind: element.kind as SolutionElementKind,
      description: boundedText(element.description, `spec.solutionElements[${index}].description`, 4_000),
      acceptanceCriterionRefs: textList(element.acceptanceCriterionRefs, `spec.solutionElements[${index}].acceptanceCriterionRefs`),
      constraintRefs: textList(element.constraintRefs, `spec.solutionElements[${index}].constraintRefs`),
      estimatedCost: element.estimatedCost as EstimatedCost,
      removalImpact: boundedText(element.removalImpact, `spec.solutionElements[${index}].removalImpact`, 4_000),
      evidence: textList(element.evidence, `spec.solutionElements[${index}].evidence`),
    };
  });
  ensureIds(solutionElements, "spec.solutionElements");

  const requirementIds = new Set(requirements.map(({ id }) => id));
  for (const component of components) {
    if (component.requirementRefs.some((id) => !requirementIds.has(id))) {
      throw new SpecBundleValidationError(`component ${component.id} references an unknown requirement`);
    }
  }

  return {
    schemaVersion: specBundleSchemaVersion,
    proposal: {
      summary: boundedText(proposal.summary, "spec.proposal.summary"),
      value: boundedText(proposal.value, "spec.proposal.value"),
      inScope: textList(proposal.inScope, "spec.proposal.inScope", { minimum: 1 }),
      outOfScope: textList(proposal.outOfScope, "spec.proposal.outOfScope"),
      deliverySlices: textList(proposal.deliverySlices, "spec.proposal.deliverySlices", { minimum: 1 }),
    },
    prd: {
      problem: boundedText(prd.problem, "spec.prd.problem"),
      users: textList(prd.users, "spec.prd.users", { minimum: 1 }),
      requirements,
      nonGoals: textList(prd.nonGoals, "spec.prd.nonGoals"),
      constraints: textList(prd.constraints, "spec.prd.constraints"),
    },
    architecture: {
      summary: boundedText(architecture.summary, "spec.architecture.summary"),
      components,
      decisions: textList(architecture.decisions, "spec.architecture.decisions", { minimum: 1 }),
    },
    migration: {
      required: migration.required,
      steps: textList(migration.steps, "spec.migration.steps", { minimum: migration.required ? 1 : 0 }),
      verification: textList(migration.verification, "spec.migration.verification", { minimum: migration.required ? 1 : 0 }),
    },
    rollback: {
      triggers: textList(rollback.triggers, "spec.rollback.triggers", { minimum: 1 }),
      steps: textList(rollback.steps, "spec.rollback.steps", { minimum: 1 }),
      dataRecovery: boundedText(rollback.dataRecovery, "spec.rollback.dataRecovery"),
    },
    solutionElements,
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
