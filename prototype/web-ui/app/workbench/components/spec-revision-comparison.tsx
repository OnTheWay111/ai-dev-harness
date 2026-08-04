import type { SpecRevisionView } from
  "../../control-plane/application/spec-generation-service";

function TextList({ values }: { values: readonly string[] }) {
  return values.length > 0
    ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
    : <p>无</p>;
}

export function SpecRevisionComparison({
  revisions,
  selectedRevisionId,
  onSelect,
}: {
  revisions: readonly SpecRevisionView[];
  selectedRevisionId: string;
  onSelect(revisionId: string): void;
}) {
  const selected = revisions.find(({ specRevision }) =>
    specRevision.id === selectedRevisionId
  ) ?? revisions.at(-1);
  if (!selected) return null;
  const bundle = selected.artifact.content;
  const diff = selected.changesFromPrevious;
  return (
    <section className="spec-comparison" aria-labelledby="spec-comparison-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">REVISION COMPARISON</p>
          <h3 id="spec-comparison-heading">Proposal / PRD 修订对比</h3>
          <p>选择任一不可变修订；差异始终与它的直接前序比较。</p>
        </div>
      </div>

      <nav className="spec-revision-tabs" aria-label="规格修订列表">
        {revisions.map(({ specRevision }) => (
          <button
            key={specRevision.id}
            type="button"
            aria-pressed={specRevision.id === selected.specRevision.id}
            onClick={() => onSelect(specRevision.id)}
          >
            <strong>Revision {specRevision.revision}</strong>
            <small>{specRevision.status} · v{specRevision.version}</small>
          </button>
        ))}
      </nav>

      <div className="spec-document-grid">
        <article>
          <p className="eyebrow">PROPOSAL</p>
          <h4>{bundle.proposal.summary}</h4>
          <p>{bundle.proposal.value}</p>
          <h5>范围内</h5>
          <TextList values={bundle.proposal.inScope} />
          <h5>范围外</h5>
          <TextList values={bundle.proposal.outOfScope} />
          <h5>交付切片</h5>
          <TextList values={bundle.proposal.deliverySlices} />
        </article>
        <article>
          <p className="eyebrow">PRD</p>
          <h4>{bundle.prd.problem}</h4>
          <h5>需求</h5>
          <ol>
            {bundle.prd.requirements.map((requirement) => (
              <li key={requirement.id}>
                <strong>{requirement.id}</strong> {requirement.statement}
                <small>验收引用：{requirement.acceptanceCriterionRefs.join("、")}</small>
              </li>
            ))}
          </ol>
          <h5>约束</h5>
          <TextList values={bundle.prd.constraints} />
          <h5>非目标</h5>
          <TextList values={bundle.prd.nonGoals} />
        </article>
      </div>

      <div className="spec-diff" aria-live="polite">
        <div className="spec-diff-summary">
          <strong>与前序修订的结构化差异</strong>
          {diff
            ? <span>新增 {diff.counts.added} · 删除 {diff.counts.removed} · 修改 {diff.counts.changed}</span>
            : <span>首个修订，无前序差异</span>}
        </div>
        {diff && diff.changes.length === 0 && <p>内容与前序修订一致。</p>}
        {diff?.changes.map((change, index) => (
          <article className={`spec-diff-row ${change.kind}`} key={`${change.path}-${index}`}>
            <header>
              <span>{change.kind}</span>
              <code>{change.path}</code>
            </header>
            {change.before !== null && <p><del>{change.before}</del></p>}
            {change.after !== null && <p><ins>{change.after}</ins></p>}
          </article>
        ))}
      </div>
    </section>
  );
}
