import type { ClassificationTimeline } from "../domain/classification.ts";
import type { ClarificationScope } from "../domain/clarification-history.ts";
import { VersionConflictError } from "../domain/errors.ts";
import type { ClassificationRepository } from "../ports/classification-repository.ts";

const key = (scope: ClarificationScope) => `${scope.organizationId}/${scope.projectId}/${scope.goalId}`;

export class MemoryClassificationRepository implements ClassificationRepository {
  private readonly timelines = new Map<string, ClassificationTimeline>();
  private readonly policies = new Map<string, ClassificationTimeline["policies"][number]>();

  async getTimeline(scope: ClarificationScope) {
    return structuredClone(this.timelines.get(key(scope)) ?? { policies: [], classifications: [] });
  }

  async append(input: Parameters<ClassificationRepository["append"]>[0]) {
    const timeline = this.timelines.get(key(input.classification)) ?? { policies: [], classifications: [] };
    if ((timeline.classifications.at(-1)?.id ?? null) !== input.expectedPreviousClassificationId) {
      throw new VersionConflictError();
    }
    let policy = this.policies.get(input.policy.digest);
    if (!policy) {
      policy = structuredClone(input.policy);
      this.policies.set(policy.digest, policy);
    }
    if (!timeline.policies.some(({ id }) => id === policy.id)) timeline.policies.push(policy);
    const classification = { ...structuredClone(input.classification), policyRevisionId: policy.id };
    timeline.classifications.push(classification);
    this.timelines.set(key(classification), timeline);
    return structuredClone({ policy, classification });
  }
}
