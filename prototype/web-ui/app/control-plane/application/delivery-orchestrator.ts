import type { CredentialBrokerPort } from
  "../ports/credential-broker-port.ts";
import type { DeliveryRepository } from
  "../ports/delivery-repository.ts";
import type { GitDeliveryPort } from "../ports/git-delivery-port.ts";
import type { EvidenceRepository } from
  "../ports/evidence-repository.ts";
import type { DeliveryCandidate } from "../domain/delivery.ts";
import type { DeliveryPolicyService } from
  "./delivery-policy-service.ts";

export class DeliveryOrchestrator {
  private readonly repository: DeliveryRepository;
  private readonly evidenceRepository: EvidenceRepository;
  private readonly policyService: DeliveryPolicyService;
  private readonly credentialBroker: CredentialBrokerPort;
  private readonly git: GitDeliveryPort;
  private readonly actorId: string;
  private readonly clock: () => Date;

  constructor(input: {
    repository: DeliveryRepository;
    evidenceRepository: EvidenceRepository;
    policyService: DeliveryPolicyService;
    credentialBroker: CredentialBrokerPort;
    git: GitDeliveryPort;
    actorId: string;
    clock?: () => Date;
  }) {
    this.repository = input.repository;
    this.evidenceRepository = input.evidenceRepository;
    this.policyService = input.policyService;
    this.credentialBroker = input.credentialBroker;
    this.git = input.git;
    this.actorId = input.actorId;
    this.clock = input.clock ?? (() => new Date());
  }

  async checkpoint(
    candidateId: string,
    idempotencyKey: string,
  ): Promise<DeliveryCandidate> {
    this.validateOperationKey(idempotencyKey);
    const replay = await this.repository.findOperation(candidateId, idempotencyKey);
    if (replay) return replay;
    const candidate = await this.requiredCandidate(candidateId);
    if (candidate.state !== "verified" || candidate.commitSha) {
      throw new Error("Only a verified candidate without a commit can be checkpointed");
    }
    const receipt = await this.git.createCommit({
      operationKey: `${candidate.id}:${idempotencyKey}:commit`,
      worktreePath: candidate.worktreePath,
      branch: candidate.branch,
      baselineSha: candidate.baselineSha,
      message: candidate.commitMessage,
    });
    const committed = await this.repository.transition({
      candidateId,
      expectedVersion: candidate.version,
      expectedStates: ["verified"],
      nextState: "committed",
      patch: { commitSha: receipt.commitSha },
      action: "delivery.commit.created",
      operationKey: idempotencyKey,
      actorId: this.actorId,
      occurredAt: this.clock().toISOString(),
      details: { commitSha: receipt.commitSha, summary: receipt.summary },
    });
    return committed;
  }

  async deliver(
    candidateId: string,
    idempotencyKey: string,
  ): Promise<DeliveryCandidate> {
    this.validateOperationKey(idempotencyKey);
    const replay = await this.repository.findOperation(candidateId, idempotencyKey);
    if (replay) return replay;
    let candidate = await this.requiredCandidate(candidateId);
    if (!candidate.commitSha) throw new Error("Delivery candidate has no commit");
    if (candidate.state === "local_ready" || candidate.state === "pr_open") {
      return await this.repository.rememberOperation(candidateId, idempotencyKey);
    }
    const commitSha = candidate.commitSha;
    const review = await this.evidenceRepository.findApprovedReview({
      organizationId: candidate.organizationId,
      projectId: candidate.projectId,
      issueId: candidate.issueId,
      runId: candidate.runId,
      targetCommitSha: commitSha,
    });
    if (!review) {
      throw new Error("Delivery requires an approved independent review for this commit");
    }
    if (candidate.state === "committed") {
      candidate = await this.repository.transition({
        candidateId,
        expectedVersion: candidate.version,
        expectedStates: ["committed"],
        nextState: "reviewed",
        patch: { reviewId: review.id },
        action: "delivery.review.accepted",
        operationKey: `${idempotencyKey}:review`,
        actorId: this.actorId,
        occurredAt: this.clock().toISOString(),
        details: { reviewId: review.id, targetCommitSha: review.targetCommitSha },
      });
    }
    const decision = await this.policyService.authorize({
      organizationId: candidate.organizationId,
      projectId: candidate.projectId,
      repositoryId: candidate.repositoryId,
      baselineBranch: candidate.baselineBranch,
      baselineSha: candidate.baselineSha,
      branch: candidate.branch,
      commitSha,
    });
    if (decision.policy.mode === "push_disabled") {
      if (candidate.state === "branch_pushed") {
        return await this.repository.rememberOperation(candidateId, idempotencyKey);
      }
      candidate = await this.repository.transition({
        candidateId,
        expectedVersion: candidate.version,
        expectedStates: ["reviewed"],
        nextState: "local_ready",
        action: "delivery.local_candidate.ready",
        operationKey: `${idempotencyKey}:local`,
        actorId: this.actorId,
        occurredAt: this.clock().toISOString(),
        details: { commitSha },
      });
      await this.repository.rememberOperation(candidateId, idempotencyKey);
      return candidate;
    }
    if (!decision.credential) throw new Error("Push credential was not authorized");
    const credential = await this.credentialBroker.acquire(
      decision.credential,
      decision.requiredScopes,
    );
    try {
      if (candidate.state === "reviewed") {
        const push = await this.git.pushBranch({
          operationKey: `${candidate.id}:${idempotencyKey}:push`,
          worktreePath: candidate.worktreePath,
          branch: candidate.branch,
          commitSha,
          credential,
        });
        candidate = await this.repository.transition({
          candidateId,
          expectedVersion: candidate.version,
          expectedStates: ["reviewed"],
          nextState: "branch_pushed",
          patch: { pushReceipt: push },
          action: "delivery.push.completed",
          operationKey: `${idempotencyKey}:push`,
          actorId: this.actorId,
          occurredAt: this.clock().toISOString(),
          details: {
            receiptId: push.receiptId,
            remoteBranch: push.remoteBranch,
            commitSha: push.commitSha,
          },
        });
      }
      if (decision.policy.mode === "push_and_open_pr" &&
        candidate.state === "branch_pushed") {
        const pullRequest = await this.git.openPullRequest({
          operationKey: `${candidate.id}:${idempotencyKey}:pr`,
          repositoryId: candidate.repositoryId,
          branch: candidate.branch,
          baselineBranch: candidate.baselineBranch,
          commitSha,
          credential,
        });
        candidate = await this.repository.transition({
          candidateId,
          expectedVersion: candidate.version,
          expectedStates: ["branch_pushed"],
          nextState: "pr_open",
          patch: { pullRequest },
          action: "delivery.pull_request.opened",
          operationKey: `${idempotencyKey}:pr`,
          actorId: this.actorId,
          occurredAt: this.clock().toISOString(),
          details: {
            externalId: pullRequest.externalId,
            headBranch: pullRequest.headBranch,
            baseBranch: pullRequest.baseBranch,
          },
        });
      }
    } finally {
      await credential.release();
    }
    return await this.repository.rememberOperation(candidateId, idempotencyKey);
  }

  async land(
    candidateId: string,
    idempotencyKey: string,
    gates: {
      humanGateApproved: boolean;
      platformChecksPassed: boolean;
    },
  ): Promise<DeliveryCandidate> {
    this.validateOperationKey(idempotencyKey);
    const replay = await this.repository.findOperation(candidateId, idempotencyKey);
    if (replay) return replay;
    let candidate = await this.requiredCandidate(candidateId);
    if (candidate.state === "landed") {
      return await this.repository.rememberOperation(candidateId, idempotencyKey);
    }
    if (!gates.humanGateApproved) {
      throw new Error("Landing requires an explicit human gate approval");
    }
    if (!gates.platformChecksPassed) {
      throw new Error("Landing requires all platform checks to pass");
    }
    if ((candidate.state !== "pr_open" && candidate.state !== "landing") ||
      !candidate.pullRequest ||
      !candidate.commitSha) {
      throw new Error("Only an open or recovering pull request can enter Landing");
    }
    const commitSha = candidate.commitSha;
    const decision = await this.policyService.authorize({
      organizationId: candidate.organizationId,
      projectId: candidate.projectId,
      repositoryId: candidate.repositoryId,
      baselineBranch: candidate.baselineBranch,
      baselineSha: candidate.baselineSha,
      branch: candidate.branch,
      commitSha,
    });
    if (decision.policy.mode !== "push_and_open_pr" || !decision.credential) {
      throw new Error("Project policy does not allow PR Landing");
    }
    if (candidate.state === "pr_open") {
      candidate = await this.repository.transition({
        candidateId,
        expectedVersion: candidate.version,
        expectedStates: ["pr_open"],
        nextState: "landing",
        action: "delivery.landing.started",
        operationKey: `${idempotencyKey}:start`,
        actorId: this.actorId,
        occurredAt: this.clock().toISOString(),
        details: {
          pullRequestId: candidate.pullRequest.externalId,
          humanGateApproved: true,
          platformChecksPassed: true,
        },
      });
    }
    const credential = await this.credentialBroker.acquire(
      decision.credential,
      decision.requiredScopes,
    );
    try {
      const landing = await this.git.mergePullRequest({
        operationKey: `${candidate.id}:${idempotencyKey}:landing`,
        repositoryId: candidate.repositoryId,
        pullRequest: candidate.pullRequest!,
        expectedCommitSha: commitSha,
        credential,
      });
      candidate = await this.repository.transition({
        candidateId,
        expectedVersion: candidate.version,
        expectedStates: ["landing"],
        nextState: "landed",
        patch: { landing },
        action: "delivery.landed",
        operationKey: `${idempotencyKey}:landed`,
        actorId: this.actorId,
        occurredAt: this.clock().toISOString(),
        details: {
          pullRequestId: landing.externalId,
          landingCommitSha: landing.landingCommitSha,
        },
      });
    } finally {
      await credential.release();
    }
    await this.repository.rememberOperation(candidateId, idempotencyKey);
    return candidate;
  }

  private async requiredCandidate(id: string): Promise<DeliveryCandidate> {
    const candidate = await this.repository.getCandidate(id);
    if (!candidate) throw new Error("Delivery candidate was not found");
    return candidate;
  }

  private validateOperationKey(value: string): void {
    if (value.length < 8 || value.length > 200 || /[\r\n\0]/.test(value)) {
      throw new Error("Delivery idempotency key is invalid");
    }
  }
}
