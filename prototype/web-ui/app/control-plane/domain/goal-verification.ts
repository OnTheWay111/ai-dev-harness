import type { AcceptanceVerificationPlan } from "./acceptance-verification.ts";
import type { GoalContract } from "./goal-contract.ts";

export const goalVerifierOutputSchemaVersion = "goal-verifier-output.v1" as const;
export const goalVerificationSchemaVersion = "goal-verification.v1" as const;

export type CriterionVerificationVerdict = "passed" | "failed" | "needs_manual";
export type GoalVerificationVerdict = CriterionVerificationVerdict;

export interface DeterministicVerificationResult {
  entryId: string;
  criterionRef: string;
  status: CriterionVerificationVerdict;
  evidenceRefs: readonly string[];
  summary: string;
  durationMs: number;
  manualApproval?: {
    actorId: string;
    role: "approver";
    reason: string;
    signedAt: string;
  };
}

export interface GoalVerifierOutput {
  schemaVersion: typeof goalVerifierOutputSchemaVersion;
  overallVerdict: GoalVerificationVerdict;
  criteria: readonly {
    criterionRef: string;
    verdict: CriterionVerificationVerdict;
    evidenceRefs: readonly string[];
    rationale: string;
  }[];
  nonGoals: readonly {
    statement: string;
    verdict: "preserved" | "violated" | "unknown";
    rationale: string;
  }[];
  constraints: readonly {
    statement: string;
    verdict: "satisfied" | "violated" | "unknown";
    rationale: string;
  }[];
  regressionRisks: readonly {
    severity: "low" | "medium" | "high" | "critical";
    description: string;
    evidenceRefs: readonly string[];
  }[];
}

export interface GoalVerification {
  schemaVersion: typeof goalVerificationSchemaVersion;
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  verificationPlanId: string;
  issuePlanId: string;
  revision: number;
  previousVerificationId: string | null;
  goalVersion: number;
  verdict: GoalVerificationVerdict;
  deterministicResults: readonly DeterministicVerificationResult[];
  verifierOutput: GoalVerifierOutput;
  verifierIdentity: string;
  verifierVersion: string;
  sessionId: string;
  verifiedAt: string;
  version: number;
}

export interface GoalVerifierRequest {
  goal: GoalContract;
  plan: AcceptanceVerificationPlan;
  deterministicResults: readonly DeterministicVerificationResult[];
  verifierIdentity: string;
  builderIdentities: readonly string[];
  session: {
    id: string;
    fresh: true;
    access: "read_only";
    canModifyCode: false;
  };
}

export class GoalVerifierContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalVerifierContractError";
  }
}

const closed = (
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
) => ({ type: "object", additionalProperties: false, required, properties });
const textSchema = { type: "string", minLength: 1 } as const;
const evidenceRefsSchema = {
  type: "array",
  maxItems: 500,
  items: textSchema,
} as const;

export const goalVerifierOutputSchema = closed(
  [
    "schemaVersion", "overallVerdict", "criteria", "nonGoals",
    "constraints", "regressionRisks",
  ],
  {
    schemaVersion: { type: "string", const: goalVerifierOutputSchemaVersion },
    overallVerdict: {
      type: "string",
      enum: ["passed", "failed", "needs_manual"],
    },
    criteria: {
      type: "array",
      maxItems: 50,
      items: closed(
        ["criterionRef", "verdict", "evidenceRefs", "rationale"],
        {
          criterionRef: textSchema,
          verdict: {
            type: "string",
            enum: ["passed", "failed", "needs_manual"],
          },
          evidenceRefs: evidenceRefsSchema,
          rationale: textSchema,
        },
      ),
    },
    nonGoals: {
      type: "array",
      maxItems: 50,
      items: closed(
        ["statement", "verdict", "rationale"],
        {
          statement: textSchema,
          verdict: {
            type: "string",
            enum: ["preserved", "violated", "unknown"],
          },
          rationale: textSchema,
        },
      ),
    },
    constraints: {
      type: "array",
      maxItems: 50,
      items: closed(
        ["statement", "verdict", "rationale"],
        {
          statement: textSchema,
          verdict: {
            type: "string",
            enum: ["satisfied", "violated", "unknown"],
          },
          rationale: textSchema,
        },
      ),
    },
    regressionRisks: {
      type: "array",
      maxItems: 100,
      items: closed(
        ["severity", "description", "evidenceRefs"],
        {
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
          },
          description: textSchema,
          evidenceRefs: evidenceRefsSchema,
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
    throw new GoalVerifierContractError(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in record))) {
    throw new GoalVerifierContractError(`${name} has an invalid shape`);
  }
  return record;
}

function text(value: unknown, name: string, maximum = 8_000): string {
  if (typeof value !== "string" || !value.trim() ||
    value.trim().length > maximum) {
    throw new GoalVerifierContractError(`${name} must be non-blank and bounded`);
  }
  return value.trim();
}

function texts(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new GoalVerifierContractError(`${name} must be a bounded list`);
  }
  const result = value.map((item, index) => text(item, `${name}[${index}]`, 1_000));
  if (new Set(result).size !== result.length) {
    throw new GoalVerifierContractError(`${name} contains duplicates`);
  }
  return result;
}

export function validateGoalVerifierOutput(
  value: unknown,
  goal: GoalContract,
): GoalVerifierOutput {
  const record = object(value, "verifierOutput", [
    "schemaVersion",
    "overallVerdict",
    "criteria",
    "nonGoals",
    "constraints",
    "regressionRisks",
  ]);
  if (record.schemaVersion !== goalVerifierOutputSchemaVersion ||
    !["passed", "failed", "needs_manual"].includes(String(record.overallVerdict))) {
    throw new GoalVerifierContractError("Verifier schema version or verdict is invalid");
  }
  if (!Array.isArray(record.criteria) || !Array.isArray(record.nonGoals) ||
    !Array.isArray(record.constraints) || !Array.isArray(record.regressionRisks)) {
    throw new GoalVerifierContractError("Verifier sections must be arrays");
  }
  const criteria = record.criteria.map((value, index) => {
    const item = object(value, `criteria[${index}]`, [
      "criterionRef", "verdict", "evidenceRefs", "rationale",
    ]);
    if (!["passed", "failed", "needs_manual"].includes(String(item.verdict))) {
      throw new GoalVerifierContractError(`criteria[${index}].verdict is invalid`);
    }
    return {
      criterionRef: text(item.criterionRef, `criteria[${index}].criterionRef`, 200),
      verdict: item.verdict as CriterionVerificationVerdict,
      evidenceRefs: texts(item.evidenceRefs, `criteria[${index}].evidenceRefs`),
      rationale: text(item.rationale, `criteria[${index}].rationale`),
    };
  });
  const expectedCriteria = goal.acceptanceCriteria.map(({ id }) => id).sort();
  const actualCriteria = criteria.map(({ criterionRef }) => criterionRef).sort();
  if (actualCriteria.length !== expectedCriteria.length ||
    actualCriteria.some((reference, index) => reference !== expectedCriteria[index])) {
    throw new GoalVerifierContractError(
      "Verifier must return exactly one verdict per AcceptanceCriterion",
    );
  }
  const boundary = <T extends "nonGoals" | "constraints">(
    name: T,
    expected: readonly string[],
    allowed: readonly string[],
  ) => {
    const items = (record[name] as unknown[]).map((value, index) => {
      const item = object(value, `${name}[${index}]`, [
        "statement", "verdict", "rationale",
      ]);
      if (!allowed.includes(String(item.verdict))) {
        throw new GoalVerifierContractError(`${name}[${index}].verdict is invalid`);
      }
      return {
        statement: text(item.statement, `${name}[${index}].statement`, 2_000),
        verdict: String(item.verdict),
        rationale: text(item.rationale, `${name}[${index}].rationale`),
      };
    });
    const actual = items.map(({ statement }) => statement).sort();
    const sortedExpected = [...expected].sort();
    if (actual.length !== sortedExpected.length ||
      actual.some((statement, index) => statement !== sortedExpected[index])) {
      throw new GoalVerifierContractError(`${name} coverage is incomplete`);
    }
    return items;
  };
  const nonGoals = boundary("nonGoals", goal.nonGoals, [
    "preserved", "violated", "unknown",
  ]) as GoalVerifierOutput["nonGoals"];
  const constraints = boundary("constraints", goal.constraints, [
    "satisfied", "violated", "unknown",
  ]) as GoalVerifierOutput["constraints"];
  const regressionRisks = record.regressionRisks.map((value, index) => {
    const item = object(value, `regressionRisks[${index}]`, [
      "severity", "description", "evidenceRefs",
    ]);
    if (!["low", "medium", "high", "critical"].includes(String(item.severity))) {
      throw new GoalVerifierContractError(
        `regressionRisks[${index}].severity is invalid`,
      );
    }
    return {
      severity: item.severity as "low" | "medium" | "high" | "critical",
      description: text(item.description, `regressionRisks[${index}].description`),
      evidenceRefs: texts(
        item.evidenceRefs,
        `regressionRisks[${index}].evidenceRefs`,
      ),
    };
  });
  return {
    schemaVersion: goalVerifierOutputSchemaVersion,
    overallVerdict: record.overallVerdict as GoalVerificationVerdict,
    criteria,
    nonGoals,
    constraints,
    regressionRisks,
  };
}
