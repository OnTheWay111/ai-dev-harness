import type { OverdesignReview } from
  "../../control-plane/domain/overdesign-review";

const tone = {
  Required: "success",
  Helpful: "warning",
  Speculative: "danger",
} as const;

export function OverdesignReviewPanel({ review }: { review: OverdesignReview }) {
  return (
    <section className="overdesign-review" aria-labelledby="overdesign-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">OVERDESIGN REVIEW</p>
          <h3 id="overdesign-heading">最小执行合同检查</h3>
          <p>确定性规则逐项追溯验收标准与约束；模型不能决定门禁。</p>
        </div>
        <span className="ai-badge">Policy {review.policyRevision}</span>
      </div>
      <div className="overdesign-counts" aria-label="分类计数">
        {Object.entries(review.counts).map(([category, count]) => (
          <span className={`status-pill ${tone[category as keyof typeof tone]}`} key={category}>
            {category} {count}
          </span>
        ))}
      </div>
      <div className="overdesign-items">
        {review.items.map((item) => (
          <article className="overdesign-item" key={item.elementId}>
            <header>
              <strong>{item.title}</strong>
              <span>{item.category}</span>
            </header>
            <p><code>{item.elementId}</code> · {item.rationale}</p>
            <dl>
              <div><dt>预估成本</dt><dd>{item.estimatedCost}</dd></div>
              <div><dt>需求引用</dt><dd>{item.requirementRefs.join(", ") || "无"}</dd></div>
              <div><dt>约束引用</dt><dd>{item.constraintRefs.join(", ") || "无"}</dd></div>
              <div><dt>删除影响</dt><dd>{item.removalImpact}</dd></div>
              <div><dt>证据</dt><dd>{item.evidence.join(", ") || "无"}</dd></div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
