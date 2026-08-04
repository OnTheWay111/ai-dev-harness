import { IdempotencyConflictError } from "../domain/errors.ts";
import type {
  QueueProjectionReceipt,
  QueueProjectionRepository,
} from "../ports/queue-projection-port.ts";

export class MemoryQueueProjectionRepository implements QueueProjectionRepository {
  private readonly values = new Map<string, QueueProjectionReceipt>();

  get receipts(): readonly QueueProjectionReceipt[] {
    return structuredClone([...this.values.values()]);
  }

  async find(input: {
    organizationId: string;
    issuePlanId: string;
    planDigest: string;
    idempotencyKey: string;
  }) {
    const receipt = this.values.get(`${input.organizationId}/${input.idempotencyKey}`);
    if (receipt) {
      if (receipt.issuePlanId !== input.issuePlanId || receipt.planDigest !== input.planDigest) {
        throw new IdempotencyConflictError();
      }
      return structuredClone(receipt);
    }
    const projected = [...this.values.values()].find((value) =>
      value.organizationId === input.organizationId &&
      value.issuePlanId === input.issuePlanId &&
      value.planDigest === input.planDigest
    );
    return projected ? structuredClone(projected) : null;
  }

  async save(receipt: QueueProjectionReceipt) {
    const existing = await this.find(receipt);
    if (existing) return existing;
    this.values.set(`${receipt.organizationId}/${receipt.idempotencyKey}`, structuredClone(receipt));
    return structuredClone(receipt);
  }
}
