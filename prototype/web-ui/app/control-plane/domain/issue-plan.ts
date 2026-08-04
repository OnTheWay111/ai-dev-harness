import type { IssueCompilationResult } from "./issue-compiler.ts";
import type { ExecutionWave, IssueConflict } from "./execution-waves.ts";
import type { ModelRecommendation } from "./model-router.ts";

export const issuePlanDraftSchemaVersion = "issue-plan-draft.v1" as const;
export const issuePlanSchemaVersion = "issue-plan.v1" as const;

export const completionEvidenceKinds = [
  "artifact",
  "test",
  "review",
  "commit",
  "push",
  "audit",
] as const;
export type CompletionEvidenceKind = (typeof completionEvidenceKinds)[number];

export interface IssueAcceptance {
  criterionRef: string;
  statement: string;
}

export interface CompletionEvidenceRequirement {
  kind: CompletionEvidenceKind;
  description: string;
  required: boolean;
}

export interface IssueConflictResources {
  directories: readonly string[];
  publicInterfaces: readonly string[];
  databaseObjects: readonly string[];
  sharedConfigurations: readonly string[];
  landingOrder: readonly string[];
}

export interface IssueDraft {
  key: string;
  title: string;
  goal: string;
  requirementRefs: readonly string[];
  acceptance: readonly IssueAcceptance[];
  nonGoals: readonly string[];
  dependencyCandidates: readonly string[];
  expectedFiles: readonly string[];
  conflictResources: IssueConflictResources;
  developmentPrompt: string;
  verify: readonly string[];
  completionEvidence: readonly CompletionEvidenceRequirement[];
}

export interface IssuePlanDraft {
  schemaVersion: typeof issuePlanDraftSchemaVersion;
  issues: readonly IssueDraft[];
}

export interface IssuePlanSource {
  specRevisionId: string;
  specRevisionVersion: number;
  specArtifactDigest: string;
  requirements: readonly {
    id: string;
    acceptanceCriterionRefs: readonly string[];
  }[];
  acceptanceCriterionIds: readonly string[];
}

export interface IssuePlannerConfiguration {
  adapter: string;
  modelProfile: string;
  schemaVersion: typeof issuePlanDraftSchemaVersion;
}

export interface IssuePlan {
  schemaVersion: typeof issuePlanSchemaVersion;
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  revision: number;
  previousPlanId: string | null;
  status: "draft" | "approved" | "rejected" | "superseded";
  source: IssuePlanSource;
  issues: readonly IssueDraft[];
  compilation: IssueCompilationResult;
  conflicts: readonly IssueConflict[];
  waves: readonly ExecutionWave[];
  modelRecommendations: readonly ModelRecommendation[];
  plannerRunId: string;
  plannerConfiguration: IssuePlannerConfiguration;
  compilerPolicyRevision: string;
  conflictPolicyRevision: string;
  modelRouterPolicyRevision: string;
  digest: string;
  generatedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class IssuePlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuePlanValidationError";
  }
}

const text = { type: "string", minLength: 1 } as const;
const texts = { type: "array", items: text } as const;
const closed = (
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
) => ({ type: "object", additionalProperties: false, required, properties });

export const issuePlanDraftOutputSchema = closed(
  ["schemaVersion", "issues"],
  {
    schemaVersion: { type: "string", const: issuePlanDraftSchemaVersion },
    issues: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: closed(
        [
          "key", "title", "goal", "requirementRefs", "acceptance", "nonGoals",
          "dependencyCandidates", "expectedFiles", "conflictResources",
          "developmentPrompt", "verify", "completionEvidence",
        ],
        {
          key: { type: "string", pattern: "^[A-Z][A-Z0-9-]{0,63}$" },
          title: text,
          goal: text,
          requirementRefs: texts,
          acceptance: {
            type: "array",
            items: closed(
              ["criterionRef", "statement"],
              { criterionRef: text, statement: text },
            ),
          },
          nonGoals: texts,
          dependencyCandidates: texts,
          expectedFiles: texts,
          conflictResources: closed(
            [
              "directories", "publicInterfaces", "databaseObjects",
              "sharedConfigurations", "landingOrder",
            ],
            {
              directories: texts,
              publicInterfaces: texts,
              databaseObjects: texts,
              sharedConfigurations: texts,
              landingOrder: texts,
            },
          ),
          developmentPrompt: { type: "string", minLength: 80 },
          verify: { type: "array", minItems: 1, items: text },
          completionEvidence: {
            type: "array",
            minItems: 1,
            items: closed(
              ["kind", "description", "required"],
              {
                kind: { type: "string", enum: completionEvidenceKinds },
                description: text,
                required: { type: "boolean" },
              },
            ),
          },
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
    throw new IssuePlanValidationError(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !keys.includes(key));
  const missing = keys.find((key) => !(key in record));
  if (unknown) throw new IssuePlanValidationError(`${name}.${unknown} is not allowed`);
  if (missing) throw new IssuePlanValidationError(`${name}.${missing} is required`);
  return record;
}

function stringValue(
  value: unknown,
  name: string,
  maximum = 10_000,
): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new IssuePlanValidationError(`${name} must be non-blank and bounded`);
  }
  return value.trim();
}

function stringArray(
  value: unknown,
  name: string,
  maximum = 200,
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new IssuePlanValidationError(`${name} must be a bounded string array`);
  }
  const result = value.map((item, index) => stringValue(item, `${name}[${index}]`, 2_000));
  if (new Set(result).size !== result.length) {
    throw new IssuePlanValidationError(`${name} must not contain duplicates`);
  }
  return result;
}

const issueKeys = [
  "key", "title", "goal", "requirementRefs", "acceptance", "nonGoals",
  "dependencyCandidates", "expectedFiles", "conflictResources",
  "developmentPrompt", "verify", "completionEvidence",
] as const;
const conflictKeys = [
  "directories", "publicInterfaces", "databaseObjects",
  "sharedConfigurations", "landingOrder",
] as const;

function validateIssue(value: unknown, index: number): IssueDraft {
  const name = `issues[${index}]`;
  const record = object(value, name, issueKeys);
  const key = stringValue(record.key, `${name}.key`, 64);
  if (!/^[A-Z][A-Z0-9-]*$/.test(key)) {
    throw new IssuePlanValidationError(`${name}.key has an invalid format`);
  }
  const title = stringValue(record.title, `${name}.title`, 300);
  const goal = stringValue(record.goal, `${name}.goal`, 4_000);
  const requirementRefs = stringArray(record.requirementRefs, `${name}.requirementRefs`, 100);
  if (!Array.isArray(record.acceptance) || record.acceptance.length > 200) {
    throw new IssuePlanValidationError(`${name}.acceptance must be a bounded array`);
  }
  const acceptance = record.acceptance.map((item, acceptanceIndex) => {
    const accepted = object(
      item,
      `${name}.acceptance[${acceptanceIndex}]`,
      ["criterionRef", "statement"],
    );
    return {
      criterionRef: stringValue(accepted.criterionRef, `${name}.acceptance[${acceptanceIndex}].criterionRef`, 100),
      statement: stringValue(accepted.statement, `${name}.acceptance[${acceptanceIndex}].statement`, 4_000),
    };
  });
  if (new Set(acceptance.map(({ criterionRef }) => criterionRef)).size !== acceptance.length) {
    throw new IssuePlanValidationError(`${name}.acceptance contains duplicate criterion refs`);
  }
  const nonGoals = stringArray(record.nonGoals, `${name}.nonGoals`, 100);
  const dependencyCandidates = stringArray(record.dependencyCandidates, `${name}.dependencyCandidates`, 100);
  const expectedFiles = stringArray(record.expectedFiles, `${name}.expectedFiles`, 500);
  const conflict = object(record.conflictResources, `${name}.conflictResources`, conflictKeys);
  const conflictResources: IssueConflictResources = {
    directories: stringArray(conflict.directories, `${name}.conflictResources.directories`, 100),
    publicInterfaces: stringArray(conflict.publicInterfaces, `${name}.conflictResources.publicInterfaces`, 100),
    databaseObjects: stringArray(conflict.databaseObjects, `${name}.conflictResources.databaseObjects`, 100),
    sharedConfigurations: stringArray(conflict.sharedConfigurations, `${name}.conflictResources.sharedConfigurations`, 100),
    landingOrder: stringArray(conflict.landingOrder, `${name}.conflictResources.landingOrder`, 100),
  };
  const developmentPrompt = stringValue(record.developmentPrompt, `${name}.developmentPrompt`, 40_000);
  if (developmentPrompt.length < 80) {
    throw new IssuePlanValidationError(`${name}.developmentPrompt is not self-contained`);
  }
  const requiredContext = [
    goal,
    ...requirementRefs,
    ...acceptance.map(({ criterionRef }) => criterionRef),
    ...acceptance.map(({ statement }) => statement),
    ...nonGoals,
    ...expectedFiles,
  ];
  if (requiredContext.some((context) => !developmentPrompt.includes(context))) {
    throw new IssuePlanValidationError(`${name}.developmentPrompt omits required context`);
  }
  const verify = stringArray(record.verify, `${name}.verify`, 50);
  if (verify.length === 0 || verify.some((command) => !developmentPrompt.includes(command))) {
    throw new IssuePlanValidationError(`${name}.developmentPrompt must include verification commands`);
  }
  if (!Array.isArray(record.completionEvidence) || record.completionEvidence.length === 0 ||
    record.completionEvidence.length > 50) {
    throw new IssuePlanValidationError(`${name}.completionEvidence must be non-empty and bounded`);
  }
  const completionEvidence = record.completionEvidence.map((item, evidenceIndex) => {
    const evidence = object(
      item,
      `${name}.completionEvidence[${evidenceIndex}]`,
      ["kind", "description", "required"],
    );
    if (!completionEvidenceKinds.includes(evidence.kind as CompletionEvidenceKind) ||
      typeof evidence.required !== "boolean") {
      throw new IssuePlanValidationError(`${name}.completionEvidence[${evidenceIndex}] is invalid`);
    }
    return {
      kind: evidence.kind as CompletionEvidenceKind,
      description: stringValue(evidence.description, `${name}.completionEvidence[${evidenceIndex}].description`, 2_000),
      required: evidence.required,
    };
  });
  if (!completionEvidence.some(({ required }) => required)) {
    throw new IssuePlanValidationError(`${name}.completionEvidence requires at least one mandatory item`);
  }
  return {
    key, title, goal, requirementRefs, acceptance, nonGoals,
    dependencyCandidates, expectedFiles, conflictResources,
    developmentPrompt, verify, completionEvidence,
  };
}

export function validateIssuePlanDraft(value: unknown): IssuePlanDraft {
  const record = object(value, "issuePlanDraft", ["schemaVersion", "issues"]);
  if (record.schemaVersion !== issuePlanDraftSchemaVersion) {
    throw new IssuePlanValidationError(`schemaVersion must be ${issuePlanDraftSchemaVersion}`);
  }
  if (!Array.isArray(record.issues) || record.issues.length === 0 || record.issues.length > 100) {
    throw new IssuePlanValidationError("issues must be non-empty and bounded");
  }
  const issues = record.issues.map(validateIssue);
  if (new Set(issues.map(({ key }) => key)).size !== issues.length) {
    throw new IssuePlanValidationError("issue keys must be unique");
  }
  return { schemaVersion: issuePlanDraftSchemaVersion, issues };
}
