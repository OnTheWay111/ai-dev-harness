import type {
  DeliveryAuditEvent,
  DeliveryCandidate,
  DeliveryCandidateState,
  LandingReceipt,
  PullRequestReceipt,
  PushReceipt,
} from "../domain/delivery.ts";

export interface DeliveryTransitionPatch {
  commitSha?: string;
  reviewId?: string;
  pushReceipt?: PushReceipt;
  pullRequest?: PullRequestReceipt;
  landing?: LandingReceipt;
}

export interface DeliveryRepository {
  getCandidate(id: string): Promise<DeliveryCandidate | null>;
  findOperation(
    candidateId: string,
    operationKey: string,
  ): Promise<DeliveryCandidate | null>;
  transition(input: {
    candidateId: string;
    expectedVersion: number;
    expectedStates: readonly DeliveryCandidateState[];
    nextState: DeliveryCandidateState;
    patch?: DeliveryTransitionPatch;
    action: string;
    operationKey: string;
    actorId: string;
    occurredAt: string;
    details?: Readonly<Record<string, unknown>>;
  }): Promise<DeliveryCandidate>;
  rememberOperation(
    candidateId: string,
    operationKey: string,
  ): Promise<DeliveryCandidate>;
  listAuditEvents(candidateId: string): Promise<readonly DeliveryAuditEvent[]>;
}
