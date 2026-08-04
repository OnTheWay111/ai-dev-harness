import type {
  DeliveryAuditEvent,
  DeliveryCandidate,
} from "../domain/delivery.ts";
import type { DeliveryRepository } from
  "../ports/delivery-repository.ts";

export class MemoryDeliveryRepository implements DeliveryRepository {
  private readonly candidates = new Map<string, DeliveryCandidate>();
  private readonly operations = new Map<string, DeliveryCandidate>();
  private readonly audits: DeliveryAuditEvent[] = [];

  constructor(input: { candidates?: readonly DeliveryCandidate[] } = {}) {
    for (const candidate of input.candidates ?? []) {
      this.candidates.set(candidate.id, structuredClone(candidate));
    }
  }

  auditEvents(): readonly DeliveryAuditEvent[] {
    return structuredClone(this.audits);
  }

  async getCandidate(id: string): Promise<DeliveryCandidate | null> {
    const candidate = this.candidates.get(id);
    return candidate ? structuredClone(candidate) : null;
  }

  async findOperation(
    candidateId: string,
    operationKey: string,
  ): Promise<DeliveryCandidate | null> {
    const candidate = this.operations.get(`${candidateId}\0${operationKey}`);
    return candidate ? structuredClone(candidate) : null;
  }

  async transition(
    input: Parameters<DeliveryRepository["transition"]>[0],
  ): Promise<DeliveryCandidate> {
    const replay = await this.findOperation(input.candidateId, input.operationKey);
    if (replay) return replay;
    const current = this.candidates.get(input.candidateId);
    if (!current) throw new Error("Delivery candidate was not found");
    if (current.version !== input.expectedVersion) {
      throw new Error("Delivery candidate version conflict");
    }
    if (!input.expectedStates.includes(current.state)) {
      throw new Error(`Delivery transition from ${current.state} is not allowed`);
    }
    const next: DeliveryCandidate = {
      ...current,
      ...structuredClone(input.patch ?? {}),
      state: input.nextState,
      version: current.version + 1,
    };
    this.candidates.set(next.id, structuredClone(next));
    this.operations.set(
      `${input.candidateId}\0${input.operationKey}`,
      structuredClone(next),
    );
    this.audits.push({
      id: crypto.randomUUID(),
      organizationId: next.organizationId,
      projectId: next.projectId,
      goalId: next.goalId,
      candidateId: next.id,
      actorId: input.actorId,
      action: input.action,
      entityVersion: next.version,
      operationKey: input.operationKey,
      occurredAt: input.occurredAt,
      details: structuredClone(input.details ?? {}),
    });
    return structuredClone(next);
  }

  async rememberOperation(
    candidateId: string,
    operationKey: string,
  ): Promise<DeliveryCandidate> {
    const existing = await this.findOperation(candidateId, operationKey);
    if (existing) return existing;
    const current = this.candidates.get(candidateId);
    if (!current) throw new Error("Delivery candidate was not found");
    this.operations.set(
      `${candidateId}\0${operationKey}`,
      structuredClone(current),
    );
    return structuredClone(current);
  }

  async listAuditEvents(
    candidateId: string,
  ): Promise<readonly DeliveryAuditEvent[]> {
    return structuredClone(this.audits.filter((event) =>
      event.candidateId === candidateId
    ));
  }
}
