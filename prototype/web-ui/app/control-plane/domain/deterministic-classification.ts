import type { GoalContract } from "./goal-contract.ts";

export type DeliverySize = "S" | "M" | "L" | "XL";
export type RiskLevel = "low" | "medium" | "high";
export type RequiredArtifact =
  | "proposal" | "prd" | "test_plan" | "architecture_decision_record"
  | "migration_plan" | "rollback_plan" | "risk_assessment" | "recovery_plan";
export type RequiredApproverRole =
  | "project_approver" | "technical_approver" | "organization_approver";

export interface ClassificationFactor {
  code: string;
  category: "size" | "risk";
  points: number;
  explanation: string;
}

export interface ClassificationOutput {
  policySchemaVersion: "classification-policy.v1";
  size: DeliverySize;
  risk: RiskLevel;
  sizeScore: number;
  riskScore: number;
  matchedFactors: ClassificationFactor[];
  requiredArtifacts: RequiredArtifact[];
  requiredApproverRoles: RequiredApproverRole[];
}

export interface ClassificationInput {
  goal: GoalContract;
  clarifications: readonly {
    blockingLevel: "blocker" | "high" | "medium" | "low";
    status: "open" | "answered";
  }[];
}

export const classificationPolicyV1 = {
  policyKey: "goal-delivery-classification",
  revision: 1,
  schemaVersion: "classification-policy.v1",
  digest: "3f5ce998f78d7a24f4b579e98ab5cdf114ba82e7d95786bc5755d70b0e6f8b1b",
  definition: {
    sizeBands: { S: [0, 1], M: [2, 3], L: [4, 7], XL: [8, null] },
    riskBands: { low: [0, 1], medium: [2, 4], high: [5, null] },
    criteriaPoints: [[2, 1], [5, 2], [10, 4], [null, 7]],
    constraintPoints: [[0, 0], [2, 1], [5, 2], [null, 3]],
    keywordGroups: {
      security: ["authentication", "authorization", "credential", "secret", "token", "rbac", "oidc", "security", "认证", "授权", "凭证", "密钥", "令牌", "安全"],
      migration: ["migration", "migrate", "schema", "迁移", "数据库", "模式"],
      production: ["production", "deployment", "rollout", "生产", "发布", "上线"],
      destructive: ["data loss", "deletion", "delete", "drop table", "destructive", "数据丢失", "删除", "删库", "破坏性"],
    },
  },
} as const;

function sizeFactor(count: number, kind: "criteria" | "constraints"):
  ClassificationFactor {
  const points = kind === "criteria"
    ? count <= 2 ? 1 : count <= 5 ? 2 : count <= 10 ? 4 : 7
    : count === 0 ? 0 : count <= 2 ? 1 : count <= 5 ? 2 : 3;
  return {
    code: `size.${kind}.${points}`,
    category: "size",
    points,
    explanation: `${count} ${kind} contribute ${points} size point(s)`,
  };
}

function includesAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

export function classifyGoal(input: ClassificationInput): ClassificationOutput {
  const sizeFactors = [
    sizeFactor(input.goal.acceptanceCriteria.length, "criteria"),
    sizeFactor(input.goal.constraints.length, "constraints"),
  ];
  const unresolved = input.clarifications.filter(({ status }) => status === "open");
  if (unresolved.length > 0) {
    sizeFactors.push({
      code: "size.unresolved_clarifications",
      category: "size",
      points: 1,
      explanation: `${unresolved.length} unresolved clarification(s) add coordination scope`,
    });
  }
  const text = [
    input.goal.title,
    input.goal.problemStatement,
    input.goal.desiredOutcome,
    ...input.goal.acceptanceCriteria.map(({ statement }) => statement),
    ...input.goal.nonGoals,
    ...input.goal.constraints,
  ].join("\n").toLocaleLowerCase("en-US");
  const riskFactors: ClassificationFactor[] = [];
  const groups = classificationPolicyV1.definition.keywordGroups;
  const riskGroup = (code: keyof typeof groups, points: number, explanation: string) => {
    if (includesAny(text, groups[code])) {
      riskFactors.push({ code: `risk.${code}`, category: "risk", points, explanation });
    }
  };
  riskGroup("security", 2, "Security, identity, or credential boundary is in scope");
  riskGroup("migration", 2, "Schema or data migration is in scope");
  riskGroup("production", 2, "Production deployment or rollout is in scope");
  riskGroup("destructive", 4, "Destructive change or data-loss language is in scope");
  const highestOpen = unresolved.some(({ blockingLevel }) => blockingLevel === "blocker")
    ? "blocker"
    : unresolved.some(({ blockingLevel }) => blockingLevel === "high") ? "high" : null;
  if (highestOpen) {
    riskFactors.push({
      code: `risk.unresolved_${highestOpen}`,
      category: "risk",
      points: highestOpen === "blocker" ? 4 : 2,
      explanation: `An unresolved ${highestOpen} clarification remains`,
    });
  }
  const sizeScore = sizeFactors.reduce((sum, factor) => sum + factor.points, 0);
  const riskScore = riskFactors.reduce((sum, factor) => sum + factor.points, 0);
  const size: DeliverySize = sizeScore <= 1 ? "S" : sizeScore <= 3 ? "M" : sizeScore <= 7 ? "L" : "XL";
  const risk: RiskLevel = riskScore <= 1 ? "low" : riskScore <= 4 ? "medium" : "high";
  const requiredArtifacts: RequiredArtifact[] = ["proposal", "prd", "test_plan"];
  if (size === "L" || size === "XL") requiredArtifacts.push("architecture_decision_record");
  if (riskFactors.some(({ code }) => code === "risk.migration")) {
    requiredArtifacts.push("migration_plan", "rollback_plan");
  }
  if (risk !== "low") requiredArtifacts.push("risk_assessment");
  if (risk === "high") requiredArtifacts.push("recovery_plan");
  const requiredApproverRoles: RequiredApproverRole[] = ["project_approver"];
  if (size === "L" || size === "XL" || risk !== "low") {
    requiredApproverRoles.push("technical_approver");
  }
  if (risk === "high") requiredApproverRoles.push("organization_approver");
  return {
    policySchemaVersion: classificationPolicyV1.schemaVersion,
    size, risk, sizeScore, riskScore,
    matchedFactors: [...sizeFactors, ...riskFactors],
    requiredArtifacts,
    requiredApproverRoles,
  };
}
