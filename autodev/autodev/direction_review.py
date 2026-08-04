"""Read-only direction checkpoint for AutoDev loops."""
from __future__ import annotations

from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
import subprocess
from typing import Any

import yaml

from autodev.config import AutoDevConfig
from autodev.run_store import append_event, load_run, mutate_run, run_paths, validate_task_id, write_conclusion_artifact
from autodev._internal.io import atomic_write_text
from autodev._internal.time import now_iso


GENERIC_GOVERNANCE_RESOURCE = "governance_generic.md"
DRIFT_STATUSES = {"queue_contract_red", "review_red", "direction_drift"}
BLOCKED_STOP_REASONS = {
    "blocking_findings",
    "consecutive_failures_stop",
    "direction_blocked",
    "failed_worktree_dirty",
    "retry_resume_failed",
}


@dataclass(frozen=True)
class DirectionReviewResult:
    status: str
    should_stop: bool
    markdown: str
    data: dict[str, Any]
    next_action: str


@dataclass(frozen=True)
class DirectionReviewWriteResult:
    status: str
    should_stop: bool
    markdown_path: Path
    yaml_path: Path
    output_markdown_path: Path
    output_yaml_path: Path
    data: dict[str, Any]


def _outcome_dict(outcome: Any) -> dict[str, Any]:
    if hasattr(outcome, "to_dict"):
        data = outcome.to_dict()
    elif isinstance(outcome, dict):
        data = dict(outcome)
    else:
        data = {
            "run_id": getattr(outcome, "run_id", ""),
            "task_id": getattr(outcome, "task_id", ""),
            "status": getattr(outcome, "status", ""),
            "ok": getattr(outcome, "ok", False),
            "message": getattr(outcome, "message", ""),
            "commit": getattr(outcome, "commit", ""),
            "worktree_path": getattr(outcome, "worktree_path", ""),
        }
    data["ok"] = bool(data.get("ok"))
    for key in ("run_id", "task_id", "status", "message", "commit", "worktree_path"):
        data[key] = str(data.get(key) or "")
    return data


def _headings(text: str) -> list[str]:
    headings: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            headings.append(stripped[:160])
        if len(headings) >= 5:
            break
    return headings


def _reference_doc_summary(config: AutoDevConfig) -> list[dict[str, Any]]:
    if config.governance.mode == "disabled":
        return []
    if config.governance.mode == "generic":
        resource = files("autodev.resources").joinpath(GENERIC_GOVERNANCE_RESOURCE)
        text = resource.read_text(encoding="utf-8")
        return [
            {
                "path": f"package:autodev.resources/{GENERIC_GOVERNANCE_RESOURCE}",
                "exists": True,
                "headings": _headings(text),
                "source": "package",
            }
        ]

    repo_root = config.project.repo_root
    docs: list[dict[str, Any]] = []
    for path in config.governance.reference_docs:
        try:
            display_path = str(path.relative_to(repo_root))
        except ValueError:
            display_path = str(path)
        docs.append(
            {
                "path": display_path,
                "exists": True,
                "headings": _headings(path.read_text(encoding="utf-8")),
                "source": "project",
            }
        )
    return docs


def _commit_summary(repo_root: Path, sha: str) -> str:
    if not sha:
        return ""
    try:
        result = subprocess.run(
            ["git", "show", "-s", "--format=%h %s", sha],
            cwd=str(repo_root),
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return sha
    summary = (result.stdout or "").strip()
    return summary or sha


def _load_review(repo_root: Path, outcome: dict[str, Any]) -> dict[str, Any]:
    task_id = outcome.get("task_id") or ""
    run_id = outcome.get("run_id") or ""
    if not task_id or not run_id:
        return {}
    try:
        task_id = validate_task_id(str(task_id))
    except ValueError:
        return {}
    path = run_paths(repo_root, run_id).tasks_dir / task_id / "review.yaml"
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return data if isinstance(data, dict) else {}


def _final_outcomes_by_task(outcomes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    final_by_task: dict[str, dict[str, Any]] = {}
    anonymous: list[dict[str, Any]] = []
    for outcome in outcomes:
        task_id = outcome.get("task_id") or ""
        if task_id:
            final_by_task[task_id] = outcome
        else:
            anonymous.append(outcome)
    return [*final_by_task.values(), *anonymous]


def _priority_counts(findings: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"P0": 0, "P1": 0}
    for finding in findings:
        priority = str(finding.get("priority") or "")
        if priority in counts:
            counts[priority] += 1
    return counts


def build_direction_review(
    config: AutoDevConfig,
    run_id: str,
    outcomes: list[Any],
    *,
    stop_reason: str,
    trigger: str,
    checkpoint_done_count: int | None = None,
) -> DirectionReviewResult:
    repo_root = config.project.repo_root
    run = load_run(repo_root, run_id)
    outcome_data = [_outcome_dict(outcome) for outcome in outcomes]
    final_outcomes = _final_outcomes_by_task(outcome_data)
    docs = _reference_doc_summary(config)
    run_summary = run.get("summary") or {}
    summary_findings = run_summary.get("findings") or {}
    summary_p0 = int(summary_findings.get("p0") or 0)
    summary_p1 = int(summary_findings.get("p1") or 0)

    review_summaries: list[dict[str, Any]] = []
    review_blocking_counts = {"P0": 0, "P1": 0}
    for outcome in outcome_data:
        review = _load_review(repo_root, outcome)
        findings = review.get("findings") or []
        if not isinstance(findings, list):
            findings = []
        counts = _priority_counts([item for item in findings if isinstance(item, dict)])
        review_blocking_counts["P0"] += counts["P0"]
        review_blocking_counts["P1"] += counts["P1"]
        if review:
            review_summaries.append(
                {
                    "task_id": outcome.get("task_id") or "",
                    "run_id": outcome.get("run_id") or "",
                    "status": str(review.get("status") or ""),
                    "message": str(review.get("message") or ""),
                    "findings": findings,
                }
            )

    unresolved = [outcome for outcome in final_outcomes if not outcome.get("ok")]
    drift_outcomes = [
        outcome for outcome in unresolved if str(outcome.get("status") or "") in DRIFT_STATUSES
    ]
    findings_out: list[dict[str, Any]] = []
    if summary_p0 or summary_p1 or review_blocking_counts["P0"] or review_blocking_counts["P1"]:
        findings_out.append(
            {
                "priority": "P1",
                "code": "unresolved_blocking_findings",
                "title": "unresolved P0/P1 findings are present",
                "evidence": {
                    "run_summary": {"p0": summary_p0, "p1": summary_p1},
                    "review_artifacts": review_blocking_counts,
                },
                "recommendation": "stop the loop and resolve blocking findings before claiming another task",
            }
        )
    for outcome in drift_outcomes:
        findings_out.append(
            {
                "priority": "P1",
                "code": "direction_drift",
                "title": f"{outcome.get('task_id') or outcome.get('run_id')} ended with {outcome.get('status')}",
                "evidence": outcome,
                "recommendation": "stop the loop and review the task contract or steward feedback",
            }
        )
    if stop_reason in BLOCKED_STOP_REASONS:
        findings_out.append(
            {
                "priority": "P1",
                "code": "blocked_stop_reason",
                "title": f"loop stopped with {stop_reason}",
                "evidence": {"stop_reason": stop_reason},
                "recommendation": "human review required before continuing the loop",
            }
        )
    elif unresolved:
        findings_out.append(
            {
                "priority": "P2",
                "code": "unresolved_task_failures",
                "title": "one or more tasks remain unresolved at checkpoint",
                "evidence": unresolved,
                "recommendation": "inspect failed task artifacts before extending the loop",
            }
        )
    status = "on_track"
    next_action = "continue"
    should_stop = False
    if any(finding["code"] == "direction_drift" for finding in findings_out) or stop_reason == "direction_drift":
        status = "drift"
        next_action = "stop_for_steward_review"
        should_stop = True
    elif any(finding["priority"] in {"P0", "P1"} for finding in findings_out) or stop_reason == "direction_blocked":
        status = "blocked"
        next_action = "resolve_blocking_findings"
        should_stop = True
    elif unresolved:
        status = "blocked"
        next_action = "review_failed_tasks"
        should_stop = True
    if config.governance.mode == "disabled":
        status = "disabled"
        next_action = "continue_without_governance"
        should_stop = False
        findings_out = []

    done_count = checkpoint_done_count
    if done_count is None:
        done_count = sum(1 for outcome in outcome_data if outcome.get("ok"))
    commits = [
        {
            "task_id": outcome.get("task_id") or "",
            "run_id": outcome.get("run_id") or "",
            "commit": outcome.get("commit") or "",
            "summary": _commit_summary(repo_root, outcome.get("commit") or ""),
        }
        for outcome in outcome_data
        if outcome.get("commit")
    ]
    data = {
        "schema_version": 1,
        "generated_at": now_iso(),
        "status": status,
        "should_stop": should_stop,
        "scope": {"type": "loop", "refs": [run_id]},
        "trigger": trigger,
        "checkpoint_done_count": done_count,
        "stop_reason": stop_reason,
        "governance_mode": config.governance.mode,
        "reference_docs": docs,
        "commits": commits,
        "tasks": outcome_data,
        "reviews": review_summaries,
        "findings": findings_out,
        "next_action": next_action,
    }
    lines = [
        "# Direction Review",
        "",
        f"- status: `{status}`",
        f"- trigger: `{trigger}`",
        f"- checkpoint_done_count: `{done_count}`",
        f"- stop_reason: `{stop_reason}`",
        f"- governance_mode: `{config.governance.mode}`",
        f"- next_action: `{next_action}`",
        "",
        "## Reference Docs",
    ]
    for doc in docs:
        marker = "ok" if doc["exists"] else "missing"
        headings = "; ".join(doc["headings"][:3]) if doc["headings"] else "-"
        lines.append(f"- `{doc['path']}`: {marker}; headings: {headings}")
    lines.extend(["", "## Tasks"])
    if outcome_data:
        for outcome in outcome_data:
            label = "PASS" if outcome["ok"] else "BLOCK"
            commit = f" commit `{outcome['commit']}`" if outcome["commit"] else ""
            lines.append(f"- {label} `{outcome['task_id'] or '-'}` `{outcome['status']}`{commit}: {outcome['message']}")
    else:
        lines.append("- none")
    lines.extend(["", "## Findings"])
    blocking_findings = [finding for finding in findings_out if finding["priority"] in {"P0", "P1", "P2"}]
    if blocking_findings:
        for finding in blocking_findings:
            lines.append(f"- [{finding['priority']}] {finding['code']}: {finding['title']}")
    else:
        lines.append("- none")
    lines.extend(["", "## Next", f"- {next_action}"])
    return DirectionReviewResult(
        status=status,
        should_stop=should_stop,
        markdown="\n".join(lines) + "\n",
        data=data,
        next_action=next_action,
    )


def write_direction_review_artifacts(
    config: AutoDevConfig,
    run_id: str,
    outcomes: list[Any],
    *,
    stop_reason: str,
    trigger: str,
    checkpoint_done_count: int | None = None,
) -> DirectionReviewWriteResult:
    result = build_direction_review(
        config,
        run_id,
        outcomes,
        stop_reason=stop_reason,
        trigger=trigger,
        checkpoint_done_count=checkpoint_done_count,
    )
    paths = run_paths(config.project.repo_root, run_id)
    yaml_text = yaml.safe_dump(result.data, allow_unicode=True, sort_keys=False)
    markdown_path = paths.run_dir / "direction_review.md"
    yaml_path = paths.run_dir / "direction_review.yaml"
    atomic_write_text(markdown_path, result.markdown)
    atomic_write_text(yaml_path, yaml_text)
    output_markdown_path = write_conclusion_artifact(
        config.project.repo_root,
        run_id,
        "direction_review.md",
        result.markdown,
    )
    output_yaml_path = write_conclusion_artifact(
        config.project.repo_root,
        run_id,
        "direction_review.yaml",
        yaml_text,
    )

    def mutate(run: dict[str, Any]) -> None:
        direction = run.setdefault("direction_check", {})
        direction["last_checked_done_count"] = result.data["checkpoint_done_count"]
        direction["verdict"] = result.status
        direction["last_trigger"] = trigger
        direction["last_review"] = str(markdown_path)
        direction["last_output"] = str(output_markdown_path)

    mutate_run(config.project.repo_root, run_id, mutate)
    append_event(
        config.project.repo_root,
        run_id,
        level="warning" if config.governance.mode == "disabled" else ("error" if result.should_stop else "info"),
        phase="direction_check",
        message=f"direction review {result.status}",
        artifact=str(output_markdown_path),
        extra={
            "trigger": trigger,
            "checkpoint_done_count": result.data["checkpoint_done_count"],
            "status": result.status,
            "should_stop": result.should_stop,
            "governance_mode": config.governance.mode,
            "yaml": str(output_yaml_path),
        },
    )
    return DirectionReviewWriteResult(
        status=result.status,
        should_stop=result.should_stop,
        markdown_path=markdown_path,
        yaml_path=yaml_path,
        output_markdown_path=output_markdown_path,
        output_yaml_path=output_yaml_path,
        data=result.data,
    )
