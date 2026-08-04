export const plannerClarificationSchemaVersion =
  "planner-clarification.v1" as const;

const identifierSchema = {
  type: "string",
} as const;

const boundedTextSchema = {
  type: "string",
} as const;

export const plannerClarificationOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "knownFacts", "uncertainties", "questions"],
  properties: {
    schemaVersion: {
      type: "string",
      enum: [plannerClarificationSchemaVersion],
    },
    knownFacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "fact", "basis"],
        properties: {
          id: identifierSchema,
          fact: boundedTextSchema,
          basis: {
            type: "string",
            enum: ["goal_contract", "human_answer"],
          },
        },
      },
    },
    uncertainties: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "statement", "impact"],
        properties: {
          id: identifierSchema,
          statement: boundedTextSchema,
          impact: boundedTextSchema,
        },
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "prompt",
          "rationale",
          "blockingLevel",
          "answerType",
          "suggestedOptions",
        ],
        properties: {
          id: identifierSchema,
          prompt: boundedTextSchema,
          rationale: boundedTextSchema,
          blockingLevel: {
            type: "string",
            enum: ["blocker", "high", "medium", "low"],
          },
          answerType: {
            type: "string",
            enum: ["single_choice", "multiple_choice", "boolean", "text", "number"],
          },
          suggestedOptions: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
      },
    },
  },
} as const;

export interface PlannerKnownFact {
  id: string;
  fact: string;
  basis: "goal_contract" | "human_answer";
}

export interface PlannerUncertainty {
  id: string;
  statement: string;
  impact: string;
}

export interface PlannerClarificationQuestion {
  id: string;
  prompt: string;
  rationale: string;
  blockingLevel: "blocker" | "high" | "medium" | "low";
  answerType: "single_choice" | "multiple_choice" | "boolean" | "text" | "number";
  suggestedOptions: string[];
}

export interface PlannerClarificationOutput {
  schemaVersion: typeof plannerClarificationSchemaVersion;
  knownFacts: PlannerKnownFact[];
  uncertainties: PlannerUncertainty[];
  questions: PlannerClarificationQuestion[];
}

export interface PlannerValidationIssue {
  path: string;
  code: string;
}

export class PlannerOutputValidationError extends Error {
  readonly code = "planner_schema_invalid" as const;
  readonly issues: readonly PlannerValidationIssue[];

  constructor(issues: readonly PlannerValidationIssue[]) {
    super("Planner output did not match planner-clarification.v1");
    this.name = "PlannerOutputValidationError";
    this.issues = issues.map(({ path, code }) => ({ path, code }));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inspectObject(
  value: unknown,
  path: string,
  required: readonly string[],
  allowed: readonly string[],
  issues: PlannerValidationIssue[],
): Record<string, unknown> | null {
  if (!isObject(value)) {
    issues.push({ path, code: "type_object" });
    return null;
  }
  for (const field of required) {
    if (!(field in value)) issues.push({ path: `${path}.${field}`, code: "required" });
  }
  const allowedFields = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      issues.push({ path: `${path}.${field}`, code: "additional_property" });
    }
  }
  return value;
}

function inspectText(
  value: unknown,
  path: string,
  issues: PlannerValidationIssue[],
  maximum = 4_000,
) {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > maximum
  ) issues.push({ path, code: "bounded_string" });
}

function inspectIdentifier(
  value: unknown,
  path: string,
  issues: PlannerValidationIssue[],
) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    issues.push({ path, code: "identifier" });
  }
}

function inspectArray(
  value: unknown,
  path: string,
  maximum: number,
  issues: PlannerValidationIssue[],
): unknown[] {
  if (!Array.isArray(value)) {
    issues.push({ path, code: "type_array" });
    return [];
  }
  if (value.length > maximum) issues.push({ path, code: "max_items" });
  return value;
}

function inspectUniqueIds(
  values: readonly unknown[],
  path: string,
  issues: PlannerValidationIssue[],
) {
  const ids = values.flatMap((value) =>
    isObject(value) && typeof value.id === "string" ? [value.id] : []
  );
  if (new Set(ids).size !== ids.length) issues.push({ path, code: "unique_ids" });
}

export function validatePlannerClarificationOutput(
  value: unknown,
): PlannerClarificationOutput {
  const issues: PlannerValidationIssue[] = [];
  const root = inspectObject(
    value,
    "$",
    ["schemaVersion", "knownFacts", "uncertainties", "questions"],
    ["schemaVersion", "knownFacts", "uncertainties", "questions"],
    issues,
  );
  if (!root) throw new PlannerOutputValidationError(issues);
  if (root.schemaVersion !== plannerClarificationSchemaVersion) {
    issues.push({ path: "$.schemaVersion", code: "const" });
  }

  const facts = inspectArray(root.knownFacts, "$.knownFacts", 50, issues);
  inspectUniqueIds(facts, "$.knownFacts", issues);
  facts.forEach((value, index) => {
    const path = `$.knownFacts[${index}]`;
    const record = inspectObject(
      value,
      path,
      ["id", "fact", "basis"],
      ["id", "fact", "basis"],
      issues,
    );
    if (!record) return;
    inspectIdentifier(record.id, `${path}.id`, issues);
    inspectText(record.fact, `${path}.fact`, issues);
    if (!new Set(["goal_contract", "human_answer"]).has(String(record.basis))) {
      issues.push({ path: `${path}.basis`, code: "enum" });
    }
  });

  const uncertainties = inspectArray(
    root.uncertainties,
    "$.uncertainties",
    50,
    issues,
  );
  inspectUniqueIds(uncertainties, "$.uncertainties", issues);
  uncertainties.forEach((value, index) => {
    const path = `$.uncertainties[${index}]`;
    const record = inspectObject(
      value,
      path,
      ["id", "statement", "impact"],
      ["id", "statement", "impact"],
      issues,
    );
    if (!record) return;
    inspectIdentifier(record.id, `${path}.id`, issues);
    inspectText(record.statement, `${path}.statement`, issues);
    inspectText(record.impact, `${path}.impact`, issues);
  });

  const questions = inspectArray(root.questions, "$.questions", 20, issues);
  inspectUniqueIds(questions, "$.questions", issues);
  questions.forEach((value, index) => {
    const path = `$.questions[${index}]`;
    const fields = [
      "id",
      "prompt",
      "rationale",
      "blockingLevel",
      "answerType",
      "suggestedOptions",
    ] as const;
    const record = inspectObject(value, path, fields, fields, issues);
    if (!record) return;
    inspectIdentifier(record.id, `${path}.id`, issues);
    inspectText(record.prompt, `${path}.prompt`, issues);
    inspectText(record.rationale, `${path}.rationale`, issues);
    if (!new Set(["blocker", "high", "medium", "low"]).has(String(record.blockingLevel))) {
      issues.push({ path: `${path}.blockingLevel`, code: "enum" });
    }
    const answerTypes = new Set([
      "single_choice",
      "multiple_choice",
      "boolean",
      "text",
      "number",
    ]);
    if (!answerTypes.has(String(record.answerType))) {
      issues.push({ path: `${path}.answerType`, code: "enum" });
    }
    const options = inspectArray(
      record.suggestedOptions,
      `${path}.suggestedOptions`,
      12,
      issues,
    );
    options.forEach((option, optionIndex) =>
      inspectText(option, `${path}.suggestedOptions[${optionIndex}]`, issues, 500)
    );
    if (new Set(options).size !== options.length) {
      issues.push({ path: `${path}.suggestedOptions`, code: "unique_items" });
    }
  });

  if (issues.length > 0) throw new PlannerOutputValidationError(issues);
  return structuredClone(value) as PlannerClarificationOutput;
}
