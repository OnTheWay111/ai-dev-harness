import { PostgresRoleBindingRepository } from
  "../../auth/postgres-role-binding-repository.ts";
import { PolicyEvaluator, type Permission } from "../../auth/rbac-policy.ts";
import { readRequestPrincipal } from "../../auth/oidc-http.ts";
import { getOidcService } from "../../auth/oidc-runtime.ts";
import { configuredWriteOrigins } from
  "../../security/request-security.ts";
import { AcceptanceVerificationPlanService } from
  "../application/acceptance-verification-plan-service.ts";
import { DeliveryReportService } from
  "../application/delivery-report-service.ts";
import { GoalVerificationService } from
  "../application/goal-verification-service.ts";
import { VerificationGapService } from
  "../application/verification-gap-service.ts";
import { CodexGoalVerifierAdapter } from
  "../adapters/codex-goal-verifier-adapter.ts";
import {
  DemoDeterministicVerifierAdapter,
  DemoGoalVerifierAdapter,
} from "../adapters/demo-goal-verifier-adapter.ts";
import { DemoDeliveryReportSource } from
  "../adapters/demo-delivery-report-source.ts";
import { IssuePlanGapRemediationAdapter } from
  "../adapters/issue-plan-gap-remediation-adapter.ts";
import { MemoryGoalVerificationRepository } from
  "../adapters/memory-goal-verification-repository.ts";
import { PostgresBuilderIdentitySource } from
  "../adapters/postgres-builder-identity-source.ts";
import { PostgresDeliveryReportSource } from
  "../adapters/postgres-delivery-report-source.ts";
import {
  type ApprovedVerificationCommand,
  PostgresDeterministicVerifier,
} from "../adapters/postgres-deterministic-verifier.ts";
import { PostgresGoalVerificationRepository } from
  "../adapters/postgres-goal-verification-repository.ts";
import {
  builtInVerificationQueries,
  PostgresVerificationReferenceCatalog,
  StaticVerificationReferenceCatalog,
} from "../adapters/postgres-verification-reference-catalog.ts";
import { createGoalVerificationHandlers } from
  "../http/goal-verification-handler.ts";
import type { GoalVerificationRepository } from
  "../ports/goal-verification-repository.ts";
import {
  getGoalWorkspacePool,
  getGoalWorkspaceRepository,
  usesDemoGoalWorkspace,
} from "./goal-workspace-runtime.ts";
import {
  getIssuePlanRepository,
  getIssuePlanService,
} from "./issue-plan-runtime.ts";
import { usesP12ContractAdapters } from
  "../testing/p12-runtime-config.ts";

let repository: GoalVerificationRepository | undefined;
let planService: AcceptanceVerificationPlanService | undefined;
let verificationService: GoalVerificationService | undefined;
let gapService: VerificationGapService | undefined;
let reportService: DeliveryReportService | undefined;
let handler: ReturnType<typeof createGoalVerificationHandlers> | undefined;

function authorizer() {
  if (usesDemoGoalWorkspace()) return { async authorize() {} };
  const policy = new PolicyEvaluator(
    new PostgresRoleBindingRepository(getGoalWorkspacePool()),
  );
  return {
    async authorize(input: {
      actorId: string;
      organizationId: string;
      projectId: string;
      permission: Permission;
    }) {
      await policy.assertAllowed(input);
    },
  };
}

function verificationCommands(): ApprovedVerificationCommand[] {
  const raw = process.env.GOAL_VERIFICATION_COMMANDS_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOAL_VERIFICATION_COMMANDS_JSON is invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > 50) {
    throw new Error("GOAL_VERIFICATION_COMMANDS_JSON must be a bounded array");
  }
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Verification command ${index} is invalid`);
    }
    const command = value as Record<string, unknown>;
    if (Object.keys(command).some((key) =>
      !["reference", "executable", "arguments", "cwd"].includes(key)
    ) || typeof command.reference !== "string" ||
      typeof command.executable !== "string" || typeof command.cwd !== "string" ||
      !command.cwd.startsWith("/") || !Array.isArray(command.arguments) ||
      command.arguments.some((argument) => typeof argument !== "string")) {
      throw new Error(`Verification command ${index} is invalid`);
    }
    return {
      reference: command.reference,
      executable: command.executable,
      arguments: command.arguments as string[],
      cwd: command.cwd,
    };
  });
}

export function getGoalVerificationRepository(): GoalVerificationRepository {
  repository ??= usesDemoGoalWorkspace()
    ? new MemoryGoalVerificationRepository()
    : new PostgresGoalVerificationRepository(getGoalWorkspacePool());
  return repository;
}

export function getAcceptanceVerificationPlanService() {
  if (planService) return planService;
  const demo = usesDemoGoalWorkspace();
  const deterministic = demo || usesP12ContractAdapters();
  const commands = deterministic ? [] : verificationCommands();
  planService = new AcceptanceVerificationPlanService({
    repository: getGoalVerificationRepository(),
    goals: getGoalWorkspaceRepository(),
    issuePlans: getIssuePlanRepository(),
    catalog: deterministic
      ? new StaticVerificationReferenceCatalog({
          command: ["command:test:p10"],
          query: builtInVerificationQueries,
          artifact: ["artifact:demo:p10"],
        })
      : new PostgresVerificationReferenceCatalog({
          pool: getGoalWorkspacePool(),
          commandReferences: commands.map(({ reference }) => reference),
        }),
    authorizer: authorizer(),
  });
  return planService;
}

export function getGoalVerificationService() {
  if (verificationService) return verificationService;
  const demo = usesDemoGoalWorkspace();
  const contract = usesP12ContractAdapters();
  const deterministic = demo || contract;
  const commands = deterministic ? [] : verificationCommands();
  verificationService = new GoalVerificationService({
    repository: getGoalVerificationRepository(),
    goals: getGoalWorkspaceRepository(),
    deterministicVerifier: deterministic
      ? new DemoDeterministicVerifierAdapter()
      : new PostgresDeterministicVerifier({
          pool: getGoalWorkspacePool(),
          commands,
        }),
    verifier: deterministic
      ? new DemoGoalVerifierAdapter()
      : new CodexGoalVerifierAdapter({
          model: process.env.CODEX_GOAL_VERIFIER_MODEL?.trim() || undefined,
        }),
    issuePlans: getIssuePlanRepository(),
    authorizer: authorizer(),
    builderIdentitySource: deterministic
      ? { async list() { return ["p12-contract-builder"]; } }
      : new PostgresBuilderIdentitySource(getGoalWorkspacePool()),
    verifierIdentity: process.env.GOAL_VERIFIER_IDENTITY?.trim() ||
      (contract
        ? "p12-contract-goal-verifier"
        : demo ? "demo-goal-verifier" : "codex-goal-verifier"),
    verifierVersion: "goal-verifier.v1",
  });
  return verificationService;
}

export function getVerificationGapService() {
  gapService ??= new VerificationGapService({
    repository: getGoalVerificationRepository(),
    remediation: new IssuePlanGapRemediationAdapter({
      repository: getIssuePlanRepository(),
      service: getIssuePlanService(),
    }),
    authorizer: authorizer(),
  });
  return gapService;
}

export function getDeliveryReportService() {
  const demo = usesDemoGoalWorkspace();
  const deterministic = demo || usesP12ContractAdapters();
  reportService ??= new DeliveryReportService({
    repository: getGoalVerificationRepository(),
    source: deterministic
      ? new DemoDeliveryReportSource({
          goals: getGoalWorkspaceRepository(),
          issuePlans: getIssuePlanRepository(),
        })
      : new PostgresDeliveryReportSource(getGoalWorkspacePool()),
    authorizer: authorizer(),
  });
  return reportService;
}

export function getGoalVerificationHandler() {
  handler ??= createGoalVerificationHandlers({
    plans: getAcceptanceVerificationPlanService(),
    verifications: getGoalVerificationService(),
    gaps: getVerificationGapService(),
    reports: getDeliveryReportService(),
    allowedOrigins: configuredWriteOrigins(),
    actorResolver: async (request) => {
      const principal = await readRequestPrincipal(request, getOidcService());
      return principal ? { actorId: principal.actorId } : null;
    },
  });
  return handler;
}
