import type { DeliveryEvidenceSummary } from "../contracts";
import { StatusPill } from "./ui";

function shortDigest(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DeliveryEvidencePanel({
  evidence,
  onDownload,
}: {
  evidence?: DeliveryEvidenceSummary;
  onDownload: (artifactId: string) => void;
}) {
  if (!evidence) {
    return (
      <section className="panel delivery-evidence-panel">
        <div className="panel-header">
          <div><p className="eyebrow">IMMUTABLE EVIDENCE</p><h3>交付证据链</h3></div>
        </div>
        <p className="delivery-evidence-empty">当前 Issue 尚未形成 Artifact、Review 或 Git 交付证据。</p>
      </section>
    );
  }
  return (
    <section className="panel delivery-evidence-panel">
      <div className="panel-header">
        <div><p className="eyebrow">IMMUTABLE EVIDENCE</p><h3>Artifact 与 Git 交付证据</h3></div>
        <StatusPill tone={evidence.latestReview?.verdict === "approved" ? "success" : "warning"}>
          {evidence.latestReview ? `独立 Review · ${evidence.latestReview.verdict}` : "等待独立 Review"}
        </StatusPill>
      </div>
      <div className="delivery-evidence-grid">
        <div>
          <h4>Artifact</h4>
          {evidence.artifacts.length === 0 ? <p>暂无已持久化证据</p> : (
            <ul className="artifact-list">
              {evidence.artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <span><strong>{artifact.kind}</strong><small>{sizeLabel(artifact.sizeBytes)} · {artifact.mediaType}</small></span>
                  <code title={artifact.digest}>digest {shortDigest(artifact.digest)}</code>
                  <button type="button" onClick={() => onDownload(artifact.id)}>申请短期下载</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="delivery-chain">
          <h4>不可变交付链</h4>
          <dl>
            <div><dt>独立 Review</dt><dd>{evidence.latestReview ? `${evidence.latestReview.reviewerType} · ${evidence.latestReview.reviewerVersion}` : "等待"}</dd></div>
            <div><dt>Commit</dt><dd><code>{evidence.commitSha ? shortDigest(evidence.commitSha) : "—"}</code></dd></div>
            <div><dt>Push</dt><dd>{evidence.push ? `${evidence.push.remoteBranch} @ ${shortDigest(evidence.push.commitSha)}` : "—"}</dd></div>
            <div><dt>PR</dt><dd>{evidence.pullRequest ? <a href={evidence.pullRequest.url} rel="noreferrer" target="_blank">#{evidence.pullRequest.externalId} · {evidence.pullRequest.status}</a> : "—"}</dd></div>
            <div><dt>Landing</dt><dd>{evidence.landing ? shortDigest(evidence.landing.commitSha) : "人工门禁后执行"}</dd></div>
          </dl>
        </div>
      </div>
    </section>
  );
}
