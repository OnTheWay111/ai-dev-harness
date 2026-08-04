"""Deterministic handoff packets for AutoDev context sharing."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

from autodev.config import AutoDevConfig
from autodev.queue_adapter import QueuePort, create_queue_port
from autodev.run_store import load_run, run_paths, validate_task_id, write_conclusion_artifact
from autodev._internal.io import atomic_write_text
from autodev._internal.time import now_iso


HANDOFF_SCHEMA_VERSION = 1
HANDOFF_HEADER = (
    "人工接手指令：先读本文件，再读队列、run.yaml、events.jsonl、verify/review artifact；"
    "如与本文件不一致，以权威文件为准。"
)
def _repo_path(config: AutoDevConfig, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return config.project.repo_root / path


def _queue_source_path(config: AutoDevConfig) -> str:
    try:
        return config.queue.path.relative_to(config.project.repo_root).as_posix()
    except ValueError:
        return str(config.queue.path)


def _task_sources(config: AutoDevConfig, run_id: str, task_id: str) -> list[str]:
    return [
        _queue_source_path(config),
        f".autodev/runs/{run_id}/run.yaml",
        f".autodev/runs/{run_id}/events.jsonl",
        f".autodev/runs/{run_id}/tasks/{task_id}/verify.json",
        f".autodev/runs/{run_id}/tasks/{task_id}/review.yaml",
    ]


def latest_handoff_path(config: AutoDevConfig) -> Path:
    return _repo_path(config, config.context_sharing.latest_handoff_path)


def latest_handoff_excerpt(config: AutoDevConfig, *, limit: int = 6000) -> str:
    if not config.context_sharing.enabled:
        return ""
    path = latest_handoff_path(config)
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    if len(text) <= limit:
        return text
    return text[-limit:]


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return data if isinstance(data, dict) else {}


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _task_snapshot(
    config: AutoDevConfig,
    task_id: str,
    queue_port: QueuePort | None = None,
) -> dict[str, Any]:
    if not task_id:
        return {}
    try:
        task = (queue_port or create_queue_port(config)).get_task(task_id)
    except Exception:
        return {"id": task_id}
    return {
        "id": str(task.get("id") or ""),
        "title": str(task.get("title") or ""),
        "status": str(task.get("status") or ""),
        "priority": str(task.get("priority") or ""),
        "area": str(task.get("area") or ""),
        "goal": str(task.get("goal") or ""),
        "acceptance": list(task.get("acceptance") or []),
        "verify": list(task.get("verify") or []),
        "artifacts": list(task.get("artifacts") or []),
        "blocked_reason": str(task.get("blocked_reason") or ""),
        "next_action": str(task.get("next_action") or ""),
    }


def _task_artifacts(config: AutoDevConfig, run_id: str, task_id: str) -> dict[str, str]:
    task_dir = run_paths(config.project.repo_root, run_id).tasks_dir / validate_task_id(task_id)
    names = ["prompt.md", "builder.json", "verify.json", "verify_summary.md", "diff.patch", "review.md", "review.yaml"]
    return {name: str(task_dir / name) for name in names if (task_dir / name).exists()}


def build_task_handoff(
    config: AutoDevConfig,
    run_id: str,
    task_id: str,
    *,
    queue_port: QueuePort | None = None,
) -> dict[str, Any]:
    task_id = validate_task_id(task_id)
    run = load_run(config.project.repo_root, run_id)
    task_dir = run_paths(config.project.repo_root, run_id).tasks_dir / task_id
    review = _read_yaml(task_dir / "review.yaml")
    verify = _read_json(task_dir / "verify.json")
    return {
        "schema_version": HANDOFF_SCHEMA_VERSION,
        "generated_at": now_iso(),
        "generated_by": "autodev_harness",
        "read_only": True,
        "handoff_type": "task",
        "manual_instruction": HANDOFF_HEADER,
        "source_of_truth": _task_sources(config, run_id, task_id),
        "run": {
            "id": run_id,
            "status": str(run.get("status") or ""),
            "next_action": str(run.get("next_action") or ""),
            "git": run.get("git") or {},
            "current_task": run.get("current_task") or {},
        },
        "task": _task_snapshot(config, task_id, queue_port),
        "review": {
            "status": str(review.get("status") or ""),
            "message": str(review.get("message") or ""),
            "findings": list(review.get("findings") or []),
            "next_action": str(review.get("next_action") or ""),
        },
        "verify": {
            "status": str(verify.get("status") or ""),
            "ok": bool(verify.get("ok")) if verify else False,
            "results": list(verify.get("results") or []),
        },
        "artifacts": _task_artifacts(config, run_id, task_id),
        "context_policy": {
            "save_context_auto_write": bool((config.context_sharing.save_context or {}).get("enabled")),
            "brain_memory_auto_write": bool((config.context_sharing.brain_memory or {}).get("auto_write")),
            "bridges_diagnostic_only": bool((config.context_sharing.bridges or {}).get("diagnostic_only", True)),
        },
    }


def _render_task_handoff_md(packet: dict[str, Any]) -> str:
    task = packet.get("task") or {}
    run = packet.get("run") or {}
    review = packet.get("review") or {}
    verify = packet.get("verify") or {}
    artifacts = packet.get("artifacts") or {}
    lines = [
        "# AutoDev Task Handoff",
        "",
        HANDOFF_HEADER,
        "",
        "## Status",
        "",
        f"- run_id: `{run.get('id')}`",
        f"- run_status: `{run.get('status')}`",
        f"- task_id: `{task.get('id')}`",
        f"- task_status: `{task.get('status')}`",
        f"- next_action: `{task.get('next_action') or run.get('next_action') or ''}`",
        "",
        "## Task",
        "",
        f"- title: {task.get('title') or ''}",
        f"- goal: {task.get('goal') or ''}",
        "",
        "### Acceptance",
    ]
    for item in task.get("acceptance") or []:
        lines.append(f"- {item}")
    if not task.get("acceptance"):
        lines.append("- none")
    lines.extend(["", "### Verify"])
    for item in task.get("verify") or []:
        lines.append(f"- `{item}`")
    if not task.get("verify"):
        lines.append("- none")
    lines.extend(
        [
            "",
            "## Git",
            "",
            f"- branch: `{(run.get('git') or {}).get('branch') or ''}`",
            f"- commit: `{(run.get('current_task') or {}).get('commit') or ''}`",
            f"- worktree: `{(run.get('git') or {}).get('worktree_path') or ''}`",
            "",
            "## Review",
            "",
            f"- status: `{review.get('status') or ''}`",
            f"- message: {review.get('message') or ''}",
        ]
    )
    findings = review.get("findings") or []
    if findings:
        for finding in findings:
            location = str(finding.get("file") or "")
            if finding.get("line"):
                location = f"{location}:{finding.get('line')}"
            lines.append(f"- [{finding.get('priority')}] {location} {finding.get('title')}")
    else:
        lines.append("- findings: none")
    lines.extend(["", "## Verify Evidence", "", f"- status: `{verify.get('status') or ''}`", f"- ok: `{verify.get('ok')}`"])
    lines.extend(["", "## Artifacts"])
    if artifacts:
        for name, path in artifacts.items():
            lines.append(f"- `{name}`: `{path}`")
    else:
        lines.append("- none")
    lines.extend(["", "## Source Of Truth"])
    for item in packet.get("source_of_truth") or []:
        lines.append(f"- `{item}`")
    return "\n".join(lines) + "\n"


def write_task_handoff(
    config: AutoDevConfig,
    run_id: str,
    task_id: str,
    *,
    queue_port: QueuePort | None = None,
    publish_latest: bool = False,
) -> tuple[Path, Path]:
    task_id = validate_task_id(task_id)
    packet = build_task_handoff(config, run_id, task_id, queue_port=queue_port)
    task_dir = run_paths(config.project.repo_root, run_id).tasks_dir / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    yaml_path = task_dir / "handoff.yaml"
    md_path = task_dir / "handoff.md"
    content = _render_task_handoff_md(packet)
    atomic_write_text(yaml_path, yaml.safe_dump(packet, allow_unicode=True, sort_keys=False))
    atomic_write_text(md_path, content)
    if publish_latest:
        latest = latest_handoff_path(config)
        latest.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(latest, content)
    return md_path, yaml_path


def build_loop_handoff(config: AutoDevConfig, run_id: str) -> dict[str, Any]:
    run = load_run(config.project.repo_root, run_id)
    paths = run_paths(config.project.repo_root, run_id)
    return {
        "schema_version": HANDOFF_SCHEMA_VERSION,
        "generated_at": now_iso(),
        "generated_by": "autodev_harness",
        "read_only": True,
        "handoff_type": "loop",
        "manual_instruction": HANDOFF_HEADER,
        "source_of_truth": [
            _queue_source_path(config),
            f".autodev/runs/{run_id}/run.yaml",
            f".autodev/runs/{run_id}/events.jsonl",
            f"outputs/autodev/{run_id}/summary.md",
            f"outputs/autodev/{run_id}/direction_review.md",
        ],
        "run": {
            "id": run_id,
            "status": str(run.get("status") or ""),
            "next_action": str(run.get("next_action") or ""),
            "summary": run.get("summary") or {},
            "current_task": run.get("current_task") or {},
            "loop": run.get("loop") or {},
        },
        "artifacts": {
            "run_yaml": str(paths.run_yaml),
            "events": str(paths.events_jsonl),
            "summary": str(paths.output_dir / "summary.md"),
            "direction_review": str(paths.output_dir / "direction_review.md"),
        },
        "context_policy": {
            "save_context_auto_write": bool((config.context_sharing.save_context or {}).get("enabled")),
            "brain_memory_auto_write": bool((config.context_sharing.brain_memory or {}).get("auto_write")),
            "bridges_diagnostic_only": bool((config.context_sharing.bridges or {}).get("diagnostic_only", True)),
        },
    }


def _render_loop_handoff_md(packet: dict[str, Any]) -> str:
    run = packet.get("run") or {}
    summary = run.get("summary") or {}
    loop = run.get("loop") or {}
    artifacts = packet.get("artifacts") or {}
    lines = [
        "# AutoDev Loop Handoff",
        "",
        HANDOFF_HEADER,
        "",
        "## Current State",
        "",
        f"- run_id: `{run.get('id')}`",
        f"- status: `{run.get('status')}`",
        f"- next_action: `{run.get('next_action') or ''}`",
        f"- tasks_done: `{summary.get('tasks_done', 0)}`",
        f"- tasks_blocked: `{summary.get('tasks_blocked', 0)}`",
        f"- consecutive_failures: `{summary.get('consecutive_failures', 0)}`",
        "",
        "## Loop Tasks",
    ]
    tasks = loop.get("tasks") or []
    if tasks:
        for item in tasks:
            lines.append(f"- `{item.get('task_id') or '-'}` `{item.get('status')}` via `{item.get('run_id')}`")
    else:
        lines.append("- none yet")
    lines.extend(["", "## Artifacts"])
    for name, path in artifacts.items():
        lines.append(f"- `{name}`: `{path}`")
    lines.extend(["", "## Source Of Truth"])
    for item in packet.get("source_of_truth") or []:
        lines.append(f"- `{item}`")
    lines.extend(
        [
            "",
            "## Bridge Policy",
            "",
            "- bridge is diagnostic only; if unavailable, continue from this packet and authoritative files.",
            "- automatic loop does not call save-context or write brain memory.",
        ]
    )
    return "\n".join(lines) + "\n"


def write_loop_handoff(config: AutoDevConfig, run_id: str) -> tuple[Path, Path]:
    packet = build_loop_handoff(config, run_id)
    content = _render_loop_handoff_md(packet)
    latest = latest_handoff_path(config)
    latest.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(latest, content)
    output = write_conclusion_artifact(config.project.repo_root, run_id, "handoff.md", content)
    run_yaml = run_paths(config.project.repo_root, run_id).run_dir / "handoff.yaml"
    atomic_write_text(run_yaml, yaml.safe_dump(packet, allow_unicode=True, sort_keys=False))
    return latest, output
