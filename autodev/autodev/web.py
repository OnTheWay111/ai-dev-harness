"""Read-only AutoDev dashboard renderer."""
from __future__ import annotations

import argparse
from collections import OrderedDict, deque
from datetime import datetime
import html
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
from threading import Condition, RLock
from time import monotonic
from typing import Any, Callable, Hashable
from urllib.parse import parse_qs, urlencode, urlparse

import yaml

from autodev.config import AutoDevConfig, load_autodev_config
from autodev.host_capacity import (
    HostCapacityBroker,
    HostCapacityError,
    load_host_policy,
    uncontrolled_snapshot,
)
from autodev.queue_adapter import QueuePort, create_queue_port
from autodev.registry import LEGACY_REGISTRY_RELATIVE, load_registry_project_configs, resolve_registry_path
from autodev.run_store import run_paths, validate_run_id, validate_task_id
from autodev.runtime_lease import (
    lease_is_live,
    read_project_loop_lease,
    run_has_live_lease,
)
from autodev._internal.io import atomic_write_text


DEFAULT_OUTPUT = "outputs/autodev/dashboard.html"
EVENT_LIMIT = 80
SUMMARY_LIMIT = 6000
RUN_PAGE_SIZE = 8
RUN_HISTORY_LIMIT = 256
ACTIVE_RUN_STATUSES = {
    "running",
    "builder_running",
    "verifying",
    "reviewing",
    "committing",
    "direction_checking",
    "waiting_capacity",
    "waiting_provider",
    "candidate_ready",
    "landing_verifying",
    "landing_waiting_provider",
    "landing_finalize_pending",
}
TERMINAL_QUEUE_STATUSES = {"done", "skipped"}
START_CONDITION_STATUSES = {
    "queue_not_committed_to_base",
    "workspace_queue_stale",
}

DASHBOARD_VIEWS = {"overview", "runs", "tasks", "events"}
RUN_DETAIL_VIEWS = {"stages", "related", "workers", "events", "artifacts"}
RUN_STATUS_FILTERS = {"all", "done", "manual", "not_started", "failed_history"}
TASK_STATUS_FILTERS = {
    "all",
    "pending",
    "in_progress",
    "blocked",
    "done",
    "skipped",
}

_YAML_CACHE_MAX_ENTRIES = 512
_YAML_CACHE_LOCK = RLock()
_YAML_CACHE: OrderedDict[str, tuple[int, int, dict[str, Any]]] = OrderedDict()


class _DashboardSnapshotCache:
    """Small TTL cache that coalesces concurrent dashboard data collection."""

    def __init__(
        self,
        ttl_seconds: float,
        *,
        clock: Callable[[], float] = monotonic,
        max_entries: int = 32,
    ):
        self._ttl_seconds = max(0.0, float(ttl_seconds))
        self._clock = clock
        self._max_entries = max(1, int(max_entries))
        self._condition = Condition()
        self._entries: dict[Hashable, tuple[float, dict[str, Any]]] = {}
        self._loading: set[Hashable] = set()

    def get(
        self,
        key: Hashable,
        loader: Callable[[], dict[str, Any]],
    ) -> dict[str, Any]:
        while True:
            with self._condition:
                now = self._clock()
                cached = self._entries.get(key)
                if cached is not None and now - cached[0] < self._ttl_seconds:
                    return cached[1]
                if key not in self._loading:
                    self._loading.add(key)
                    break
                self._condition.wait()

        try:
            value = loader()
        except BaseException:
            with self._condition:
                self._loading.discard(key)
                self._condition.notify_all()
            raise

        with self._condition:
            self._entries[key] = (self._clock(), value)
            while len(self._entries) > self._max_entries:
                oldest_key = min(self._entries, key=lambda item: self._entries[item][0])
                self._entries.pop(oldest_key, None)
            self._loading.discard(key)
            self._condition.notify_all()
        return value


def _validate_run_id(run_id: str) -> str:
    return validate_run_id(run_id) if run_id else ""


def _read_yaml(path: Path) -> dict[str, Any]:
    cache_key = str(path.resolve(strict=False))
    try:
        stat = path.stat()
    except FileNotFoundError:
        with _YAML_CACHE_LOCK:
            _YAML_CACHE.pop(cache_key, None)
        return {}
    signature = (stat.st_mtime_ns, stat.st_size)
    with _YAML_CACHE_LOCK:
        cached = _YAML_CACHE.get(cache_key)
        if cached is not None and cached[:2] == signature:
            _YAML_CACHE.move_to_end(cache_key)
            return cached[2]

    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    parsed = data if isinstance(data, dict) else {}
    with _YAML_CACHE_LOCK:
        _YAML_CACHE[cache_key] = (signature[0], signature[1], parsed)
        _YAML_CACHE.move_to_end(cache_key)
        while len(_YAML_CACHE) > _YAML_CACHE_MAX_ENTRIES:
            _YAML_CACHE.popitem(last=False)
    return parsed


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _read_text(path: Path, *, limit: int = SUMMARY_LIMIT) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    if len(text) <= limit:
        return text
    return text[:limit] + "\n\n... truncated for dashboard ...\n"


def _tail_events(path: Path, *, limit: int = EVENT_LIMIT) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    lines: deque[str] = deque(maxlen=limit)
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                lines.append(line)
    events: list[dict[str, Any]] = []
    for line in lines:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            events.append(item)
    return events


def _queue_summary(config: AutoDevConfig, queue_port: QueuePort | None = None) -> dict[str, Any]:
    try:
        result = (queue_port or create_queue_port(config)).summary()
        if result.ok and result.summary is not None:
            return result.summary
        return {"error": result.message or result.status, "counts": {}, "in_progress": [], "next": "", "proposed": []}
    except Exception as exc:
        return {"error": str(exc), "counts": {}, "in_progress": [], "next": "", "proposed": []}


def _queue_tasks_by_id(config: AutoDevConfig, queue_port: QueuePort | None = None) -> dict[str, dict[str, Any]]:
    try:
        tasks = (queue_port or create_queue_port(config)).list_tasks()
    except Exception:
        return {}
    return {
        str(task.get("id") or ""): task
        for task in tasks
        if str(task.get("id") or "")
    }


def _queue_snapshot(
    config: AutoDevConfig,
    queue_port: QueuePort | None = None,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Read queue summary and task rows once when the adapter supports it."""
    port = queue_port or create_queue_port(config)
    snapshot = getattr(port, "dashboard_snapshot", None)
    if callable(snapshot):
        try:
            result, tasks = snapshot()
        except Exception as exc:
            return (
                {"error": str(exc), "counts": {}, "in_progress": [], "next": "", "proposed": []},
                {},
            )
    else:
        try:
            result = port.summary()
        except Exception as exc:
            result = None
            summary = {"error": str(exc), "counts": {}, "in_progress": [], "next": "", "proposed": []}
        else:
            summary = (
                result.summary
                if result.ok and result.summary is not None
                else {
                    "error": result.message or result.status,
                    "counts": {},
                    "in_progress": [],
                    "next": "",
                    "proposed": [],
                }
            )
        try:
            tasks = port.list_tasks()
        except Exception:
            tasks = []
        return summary, {
            str(task.get("id") or ""): task
            for task in tasks
            if str(task.get("id") or "")
        }

    summary = (
        result.summary
        if result.ok and result.summary is not None
        else {
            "error": result.message or result.status,
            "counts": {},
            "in_progress": [],
            "next": "",
            "proposed": [],
        }
    )
    return summary, {
        str(task.get("id") or ""): task
        for task in tasks
        if str(task.get("id") or "")
    }


def _terminal_queue_projection(
    status: str,
    current_task: dict[str, Any],
    queue_tasks: dict[str, dict[str, Any]],
) -> tuple[str, str, bool]:
    task_id = str(current_task.get("id") or "")
    queue_task = queue_tasks.get(task_id) or {}
    queue_status = str(queue_task.get("status") or "")
    resolved_by_queue = bool(task_id and queue_status in TERMINAL_QUEUE_STATUSES and status != queue_status)
    if resolved_by_queue:
        raw = queue_task.get("raw") if isinstance(queue_task.get("raw"), dict) else queue_task
        completion_mode = str((raw or {}).get("completion_mode") or "")
        display_status = (
            "manual_done"
            if queue_status == "done" and completion_mode != "autodev_reviewed"
            else queue_status
        )
    else:
        display_status = status
    return display_status, queue_status, resolved_by_queue


def _run_limit_projection(status: str, run: dict[str, Any]) -> str:
    """Turn generic loop stop reasons into user-facing, unambiguous outcomes."""
    if str(status or "") != "max_tasks_reached":
        return str(status or "")
    summary = run.get("summary") or {}
    tasks = [
        item
        for item in ((run.get("loop") or {}).get("tasks") or [])
        if isinstance(item, dict)
    ]
    blocked = int(summary.get("tasks_blocked") or 0)
    if not blocked:
        blocked = sum(1 for item in tasks if not bool(item.get("ok")))
    return "batch_finished_with_blocks" if blocked else "batch_task_limit_completed"


def _execution_view(
    config: AutoDevConfig,
    run: dict[str, Any],
    queue_tasks: dict[str, dict[str, Any]],
    *,
    is_live: bool | None = None,
    run_lookup: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the read-only worker/landing view for active and historical loops."""
    loop = run.get("loop")
    if not isinstance(loop, dict):
        return {}
    active_records = [item for item in loop.get("workers") or [] if isinstance(item, dict)]
    history_records = [item for item in loop.get("worker_history") or [] if isinstance(item, dict)]
    live = _is_active_run_status(str(run.get("status") or "")) if is_live is None else is_live
    records = active_records if live else (history_records or active_records)
    outcomes = {
        str(item.get("run_id") or ""): item
        for item in loop.get("tasks") or []
        if isinstance(item, dict) and str(item.get("run_id") or "")
    }
    workers = []
    for record in records:
        task_id = str(record.get("task_id") or "")
        child_run_id = str(record.get("child_run_id") or "")
        outcome = outcomes.get(child_run_id) or {}
        child = (
            dict(run_lookup.get(child_run_id) or {})
            if run_lookup is not None
            else _read_yaml(
                run_paths(config.project.repo_root, child_run_id).run_yaml
            )
            if child_run_id
            else {}
        )
        models = _stage_agent_models(child)
        queue_task = queue_tasks.get(task_id) or {}
        raw_queue_task = queue_task.get("raw") if isinstance(queue_task.get("raw"), dict) else queue_task
        workers.append(
            {
                "worker_id": str(record.get("worker_id") or ""),
                "task_id": task_id,
                "task_title": str((raw_queue_task or {}).get("title") or queue_task.get("title") or ""),
                "child_run_id": child_run_id,
                "status": str(record.get("status") or outcome.get("status") or child.get("status") or "unknown"),
                "pid": int(record.get("pid") or 0),
                "alive": bool(record.get("alive")) if active_records else False,
                "builder": models.get("builder", ""),
                "evaluator": models.get("review", ""),
                "historical": not live,
            }
        )
    landing = []
    for outcome in loop.get("tasks") or []:
        if not isinstance(outcome, dict):
            continue
        landing.append(
            {
                "task_id": str(outcome.get("task_id") or ""),
                "child_run_id": str(outcome.get("run_id") or ""),
                "status": str(outcome.get("status") or "unknown"),
                "ok": bool(outcome.get("ok")),
            }
        )
    concurrency = max(0, int(loop.get("concurrency") or len(active_records) or len(workers)))
    return {
        "concurrency": concurrency,
        "active": len(active_records) if live else 0,
        "workers": workers,
        "landing": landing,
        "historical": not live,
    }


def _worker_board(
    config: AutoDevConfig,
    active_run_id: str,
    queue_tasks: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Return three stable UI slots while preserving the configured capacity."""
    hard_limit = 3
    configured = max(1, min(hard_limit, int(config.execution.max_parallel_tasks or 1)))
    active_run = (
        _read_yaml(run_paths(config.project.repo_root, active_run_id).run_yaml)
        if active_run_id
        else {}
    )
    execution = _execution_view(config, active_run, queue_tasks, is_live=True) if active_run else {}
    active_workers = list(execution.get("workers") or [])
    if active_run and not active_workers:
        current = active_run.get("current_task") or {}
        task_id = str(current.get("id") or "")
        if task_id:
            queue_task = queue_tasks.get(task_id) or {}
            raw = queue_task.get("raw") if isinstance(queue_task.get("raw"), dict) else queue_task
            models = _stage_agent_models(active_run)
            active_workers.append(
                {
                    "worker_id": "worker-01",
                    "task_id": task_id,
                    "task_title": str((raw or {}).get("title") or queue_task.get("title") or ""),
                    "child_run_id": active_run_id,
                    "status": str(active_run.get("status") or current.get("status") or "running"),
                    "pid": 0,
                    "alive": True,
                    "builder": models.get("builder", ""),
                    "evaluator": models.get("review", ""),
                    "historical": False,
                }
            )

    slots: list[dict[str, Any]] = []
    for index in range(hard_limit):
        if index < len(active_workers):
            slot = dict(active_workers[index])
            slot.update({"slot": index + 1, "enabled": True, "occupied": True})
        elif index < configured:
            slot = {
                "slot": index + 1,
                "worker_id": f"worker-{index + 1:02d}",
                "status": "worker_idle",
                "enabled": True,
                "occupied": False,
            }
        else:
            slot = {
                "slot": index + 1,
                "worker_id": f"worker-{index + 1:02d}",
                "status": "disabled",
                "enabled": False,
                "occupied": False,
            }
        slots.append(slot)
    return {
        "concurrency": configured,
        "hard_limit": hard_limit,
        "active": len(active_workers),
        "workers": slots,
        "landing": execution.get("landing") or [],
        "historical": False,
        "persistent": True,
    }


def _run_dirs(repo_root: Path) -> list[Path]:
    root = repo_root / ".autodev" / "runs"
    return sorted(
        (path.parent for path in root.glob("*/run.yaml")),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def _is_active_run_status(status: str) -> bool:
    normalized = str(status or "").strip().lower()
    return normalized in ACTIVE_RUN_STATUSES or normalized.endswith("_running")


def _duration_label(started_at: Any, ended_at: Any = "") -> str:
    """Format an elapsed run duration from ISO timestamps.

    An empty ``ended_at`` means the run is live, so the current time is used.
    Invalid or missing timestamps stay blank rather than breaking the read-only
    dashboard for legacy run files.
    """
    try:
        started = datetime.fromisoformat(str(started_at or "").replace("Z", "+00:00"))
        ended = (
            datetime.fromisoformat(str(ended_at).replace("Z", "+00:00"))
            if ended_at
            else datetime.now(started.tzinfo)
        )
        if started.tzinfo is None and ended.tzinfo is not None:
            started = started.replace(tzinfo=ended.tzinfo)
        elif started.tzinfo is not None and ended.tzinfo is None:
            ended = ended.replace(tzinfo=started.tzinfo)
        total_seconds = max(0, int((ended - started).total_seconds()))
    except (TypeError, ValueError):
        return ""

    days, remainder = divmod(total_seconds, 86_400)
    hours, remainder = divmod(remainder, 3_600)
    minutes, seconds = divmod(remainder, 60)
    parts = []
    if days:
        parts.append(f"{days} 天")
    if hours or days:
        parts.append(f"{hours} 小时")
    if minutes or hours or days:
        parts.append(f"{minutes} 分")
    parts.append(f"{seconds} 秒")
    return " ".join(parts)


def _timestamp_label(value: Any) -> str:
    """Render an ISO timestamp in the compact local dashboard format."""
    try:
        timestamp = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return str(value or "")
    return timestamp.strftime("%Y-%m-%d %H:%M:%S")


def _grouped_attempt_duration(entry: dict[str, Any]) -> str:
    """Return wall-clock time across every standalone attempt for one task."""
    attempts = [entry, *(entry.get("attempt_runs") or [])]

    def parsed(value: Any) -> datetime | None:
        try:
            return datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None

    starts = [value for item in attempts if (value := parsed(item.get("started_at"))) is not None]
    if not starts:
        return str(entry.get("duration") or "")
    if entry.get("is_live"):
        ended_at: Any = ""
    else:
        updates = [value for item in attempts if (value := parsed(item.get("updated_at"))) is not None]
        ended_at = max(updates).isoformat() if updates else entry.get("updated_at")
    return _duration_label(min(starts).isoformat(), ended_at)


def _latest_active_run_ids(
    repo_root: Path,
    *,
    run_dirs: list[Path] | None = None,
) -> tuple[str, str]:
    loop = read_project_loop_lease(repo_root)
    loop_run_id = str(loop.get("run_id") or "")
    if loop_run_id and lease_is_live(loop, repo_root=repo_root, run_id=loop_run_id):
        return loop_run_id, ""
    for run_dir in run_dirs if run_dirs is not None else _run_dirs(repo_root):
        data = _read_yaml(run_dir / "run.yaml")
        if _is_active_run_status(str(data.get("status") or "")):
            run_id = str(data.get("run_id") or run_dir.name)
            if run_has_live_lease(repo_root, run_id):
                return run_id, ""
            return "", run_id
    return "", ""


def _worker_summary(config: AutoDevConfig, active_run_id: str) -> dict[str, Any]:
    workers: list[dict[str, Any]] = []
    if active_run_id:
        run = _read_yaml(run_paths(config.project.repo_root, active_run_id).run_yaml)
        workers = [
            dict(item)
            for item in ((run.get("loop") or {}).get("workers") or [])
            if isinstance(item, dict)
        ]
    return {
        "active": len(workers),
        "limit": config.execution.max_parallel_tasks,
        "workers": workers,
    }


def _recent_runs(
    config: AutoDevConfig,
    *,
    queue_tasks: dict[str, dict[str, Any]] | None = None,
    limit: int = RUN_HISTORY_LIMIT,
    run_dirs: list[Path] | None = None,
) -> list[dict[str, Any]]:
    queue_tasks = queue_tasks or {}
    entries: list[dict[str, Any]] = []
    by_run_id: dict[str, dict[str, Any]] = {}
    child_to_parent: dict[str, str] = {}
    # A loop can contribute one parent plus several child directories. Reading a
    # bounded multiple keeps dashboard refresh cost stable on long-lived projects
    # while still providing enough raw records for ``limit`` logical runs.
    available_run_dirs = run_dirs if run_dirs is not None else _run_dirs(config.project.repo_root)
    for run_dir in available_run_dirs[: max(limit * 8, limit)]:
        data = _read_yaml(run_dir / "run.yaml")
        run_id = str(data.get("run_id") or run_dir.name)
        status = str(data.get("status") or "")
        current_task = dict(data.get("current_task") or {})
        task_id = str(current_task.get("id") or "")
        queue_task = queue_tasks.get(task_id) or {}
        raw_queue_task = queue_task.get("raw") if isinstance(queue_task.get("raw"), dict) else queue_task
        task_title = str((raw_queue_task or {}).get("title") or queue_task.get("title") or "")
        display_status, queue_status, resolved_by_queue = _terminal_queue_projection(
            status,
            current_task,
            queue_tasks,
        )
        if not resolved_by_queue:
            display_status = _run_limit_projection(display_status, data)
        is_live = _is_active_run_status(status) and run_has_live_lease(
            config.project.repo_root,
            run_id,
        )
        child_run_ids = [
            str(outcome.get("run_id") or "")
            for outcome in ((data.get("loop") or {}).get("tasks") or [])
            if isinstance(outcome, dict) and str(outcome.get("run_id") or "")
        ]
        entry = {
            "run_id": run_id,
            "status": status,
            "display_status": "not_started" if status in START_CONDITION_STATUSES else display_status,
            "queue_status": queue_status,
            "resolved_by_queue": resolved_by_queue,
            "started_at": str(data.get("started_at") or ""),
            "updated_at": str(data.get("updated_at") or ""),
            "updated_at_display": _timestamp_label(data.get("updated_at")),
            "duration": _duration_label(
                data.get("started_at"),
                "" if is_live else data.get("updated_at"),
            ),
            "is_live": is_live,
            "current_task": current_task,
            "task_title": task_title,
            "stages": _run_stage_timeline(run_dir, data),
            "child_run_ids": child_run_ids,
            "child_runs": [],
            "execution": _execution_view(config, data, queue_tasks, is_live=is_live),
            "is_loop": data.get("loop") is not None,
            "start_condition_unmet": status in START_CONDITION_STATUSES,
            "successor_run_id": "",
            "recovery_status": "",
            "attempt_runs": [],
        }
        entries.append(entry)
        by_run_id[run_id] = entry
        for child_run_id in child_run_ids:
            child_to_parent[child_run_id] = run_id

    # The controller records loop.tasks only after a child attempt returns. While
    # that attempt is active, use the strict controller id shape as a temporary
    # fallback, but only when the matching parent exists and is structurally a
    # loop run. This cannot swallow a standalone id that merely contains "-task-".
    loop_entries = [entry for entry in entries if entry["is_loop"]]
    for entry in entries:
        if entry["run_id"] in child_to_parent or entry["is_loop"]:
            continue
        for parent in loop_entries:
            prefix = f"{parent['run_id']}-task-"
            suffix = entry["run_id"][len(prefix):] if entry["run_id"].startswith(prefix) else ""
            if len(suffix) == 2 and suffix.isdigit():
                child_to_parent[entry["run_id"]] = parent["run_id"]
                if entry["run_id"] not in parent["child_run_ids"]:
                    parent["child_run_ids"].append(entry["run_id"])
                break

    # A run-loop and its task run describe one user-visible attempt. Keep the loop
    # as the Recent Runs row and retain the child pipeline inside its details.
    for entry in entries:
        entry["child_runs"] = [
            by_run_id[child_run_id]
            for child_run_id in entry["child_run_ids"]
            if child_run_id in by_run_id
        ]
        worker_by_child = {
            str(worker.get("child_run_id") or ""): worker
            for worker in (entry.get("execution") or {}).get("workers") or []
        }
        for child in entry["child_runs"]:
            worker = worker_by_child.get(str(child.get("run_id") or "")) or {}
            child["worker_id"] = str(worker.get("worker_id") or "")
            child["worker_task_id"] = str(worker.get("task_id") or "")

    # A pre-build condition stop is not an AI/task failure. If a newer attempt for
    # the same task exists, expose that recovery on the old logical run instead of
    # leaving an orphan-looking failure behind.
    for index, entry in enumerate(entries):
        if not entry["start_condition_unmet"]:
            continue
        if entry["queue_status"] in TERMINAL_QUEUE_STATUSES:
            entry["recovery_status"] = "recovered_done"
        elif entry["queue_status"] == "in_progress":
            entry["recovery_status"] = "recovered_running"
        task_id = str((entry.get("current_task") or {}).get("id") or "")
        if not task_id:
            continue
        for candidate in entries[:index]:
            candidate_task_id = str((candidate.get("current_task") or {}).get("id") or "")
            if candidate_task_id != task_id or candidate["status"] in START_CONDITION_STATUSES:
                continue
            successor_run_id = child_to_parent.get(candidate["run_id"], candidate["run_id"])
            successor = by_run_id.get(successor_run_id, candidate)
            entry["successor_run_id"] = successor_run_id
            successor_status = str(successor.get("status") or "")
            if entry["queue_status"] in TERMINAL_QUEUE_STATUSES:
                entry["recovery_status"] = "recovered_done"
            elif entry["queue_status"] == "in_progress" or _is_active_run_status(successor_status):
                entry["recovery_status"] = "recovered_running"
            else:
                entry["recovery_status"] = "recovered"
            break

    logical_runs = [entry for entry in entries if entry["run_id"] not in child_to_parent]

    # Repeated standalone attempts for one task are one user-facing history row.
    # Keep the newest attempt as the summary and retain older pipelines nested
    # underneath. Loop parents remain independent because one loop can own many
    # tasks and already nests its child attempts.
    grouped: list[dict[str, Any]] = []
    newest_by_task: dict[str, dict[str, Any]] = {}
    for entry in logical_runs:
        task_id = str((entry.get("current_task") or {}).get("id") or "")
        if entry.get("is_loop") or not task_id:
            grouped.append(entry)
            continue
        newest = newest_by_task.get(task_id)
        if newest is None:
            newest_by_task[task_id] = entry
            grouped.append(entry)
        else:
            newest["attempt_runs"].append(entry)
    for entry in grouped:
        if entry.get("attempt_runs"):
            entry["current_attempt_duration"] = entry.get("duration") or ""
            entry["duration"] = _grouped_attempt_duration(entry)
    return grouped[:limit]


def _dashboard_tasks(
    queue_tasks: dict[str, dict[str, Any]],
    recent_runs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Project queue tasks into read-only Dashboard rows."""
    latest_by_task: dict[str, dict[str, Any]] = {}

    def consider(run: dict[str, Any]) -> None:
        task_id = str((run.get("current_task") or {}).get("id") or "")
        if task_id and task_id not in latest_by_task:
            latest_by_task[task_id] = run

    for run in recent_runs:
        consider(run)
        for nested in run.get("attempt_runs") or []:
            consider(nested)
        for nested in run.get("child_runs") or []:
            consider(nested)

    rows = []
    for task_id, task in queue_tasks.items():
        status = str(task.get("status") or "")
        raw = task.get("raw") if isinstance(task.get("raw"), dict) else task
        last = latest_by_task.get(task_id) or {}
        last_status = str(last.get("display_status") or last.get("status") or "")
        action_label = "建议处理"
        if status == "pending" and last_status == "retry_patch_failed":
            action = "候选恢复失败；请基于上次候选继续修复，或确认取消该任务。"
        elif status == "pending":
            action = "尚未被 Worker 领取；可等待下一轮自动领取，或由人工明确接管。"
        elif status == "in_progress":
            action = "任务已被领取；请确认负责人或 Worker 是否仍在处理。"
        elif status == "blocked":
            action = "任务处于阻塞状态；请展开最近一次尝试查看失败环节并决定续修或取消。"
        elif status == "done":
            action = "任务已完成；此处保留只读队列记录和最近一次 Harness 尝试。"
            action_label = "完成情况"
        elif status == "skipped":
            action = "任务已跳过；此处保留只读队列记录供追溯。"
            action_label = "历史状态"
        else:
            action = "任务保持当前队列状态；此页面仅提供只读查看。"
            action_label = "当前状态"
        notes = list((raw or {}).get("notes") or task.get("notes") or [])
        latest_note = notes[-1] if notes else {}
        rows.append(
            {
                "task_id": task_id,
                "title": str((raw or {}).get("title") or task.get("title") or ""),
                "goal": str((raw or {}).get("goal") or task.get("goal") or ""),
                "priority": str((raw or {}).get("priority") or task.get("priority") or ""),
                "dependencies": [
                    str(item)
                    for item in ((raw or {}).get("dependencies") or task.get("dependencies") or [])
                    if str(item)
                ],
                "status": status,
                "owner": str(task.get("owner") or (raw or {}).get("owner") or ""),
                "last_run_id": str(last.get("run_id") or ""),
                "last_status": last_status,
                "action": action,
                "action_label": action_label,
                "finished_at": str(
                    (raw or {}).get("finished_at")
                    or task.get("finished_at")
                    or ""
                ),
                "latest_note": str(
                    latest_note.get("text")
                    if isinstance(latest_note, dict)
                    else latest_note
                    or ""
                ),
            }
        )
    return rows


def _actionable_tasks(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        task
        for task in tasks
        if str(task.get("status") or "") in {"pending", "in_progress", "blocked"}
    ]


def _project_cards(
    config: AutoDevConfig,
    *,
    registry_path: str | Path | None = None,
    queue_port: QueuePort | None = None,
    current_state: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    def state_for(project_config: AutoDevConfig) -> dict[str, Any]:
        is_current_project = (
            project_config.project.repo_root.resolve()
            == config.project.repo_root.resolve()
        )
        if (
            current_state is not None
            and is_current_project
        ):
            return current_state
        project_run_dirs = _run_dirs(project_config.project.repo_root)
        active_run_id, stale_run_id = _latest_active_run_ids(
            project_config.project.repo_root,
            run_dirs=project_run_dirs,
        )
        return {
            "active_run_id": active_run_id,
            "stale_run_id": stale_run_id,
            "latest_run_id": project_run_dirs[0].name if project_run_dirs else "",
            "queue": _queue_summary(
                project_config,
                queue_port if is_current_project else None,
            ),
        }

    legacy_registry = config.project.repo_root / LEGACY_REGISTRY_RELATIVE
    selected_registry = resolve_registry_path(registry_path, legacy_path=legacy_registry)
    if not selected_registry.exists():
        state = current_state or state_for(config)
        active_run_id = str(state.get("active_run_id") or "")
        stale_run_id = str(state.get("stale_run_id") or "")
        recent_run_id = str(state.get("latest_run_id") or "")
        queue = state.get("queue") or {"counts": {}}
        return [
            {
                "id": config.project.id,
                "name": config.project.name,
                "repo_root": str(config.project.repo_root),
                "config_path": "",
                "enabled": True,
                "current_run_id": active_run_id or stale_run_id or recent_run_id,
                "active_run_id": active_run_id,
                "stale_run_id": stale_run_id,
                "latest_run_id": recent_run_id,
                "queue": queue,
                "status": "queue_unavailable" if queue.get("error") else "ok",
                "error": str(queue.get("error") or ""),
                "workers": _worker_summary(config, active_run_id),
            }
        ]

    projects: list[dict[str, Any]] = []
    try:
        loaded = load_registry_project_configs(selected_registry, include_disabled=True)
    except Exception as exc:
        state = current_state or state_for(config)
        queue = state.get("queue") or {"counts": {}}
        return [
            {
                "id": config.project.id,
                "name": config.project.name,
                "repo_root": str(config.project.repo_root),
                "config_path": "",
                "enabled": True,
                "current_run_id": str(state.get("latest_run_id") or ""),
                "queue": queue,
                "status": "registry_error",
                "error": str(exc),
            }
        ]
    for entry, project_config, error in loaded:
        if project_config is None:
            projects.append(
                {
                    "id": entry.id,
                    "name": entry.name,
                    "repo_root": "",
                    "config_path": str(entry.config_path),
                    "enabled": entry.enabled,
                    "current_run_id": "",
                    "queue": {"counts": {}},
                    "status": "disabled" if error == "disabled" else "error",
                    "error": error,
                }
            )
            continue
        state = state_for(project_config)
        active_run_id = str(state.get("active_run_id") or "")
        stale_run_id = str(state.get("stale_run_id") or "")
        recent_run_id = str(state.get("latest_run_id") or "")
        queue = state.get("queue") or {"counts": {}}
        projects.append(
            {
                "id": project_config.project.id,
                "name": project_config.project.name,
                "repo_root": str(project_config.project.repo_root),
                "config_path": str(entry.config_path),
                "enabled": entry.enabled,
                "current_run_id": active_run_id or stale_run_id or recent_run_id,
                "active_run_id": active_run_id,
                "stale_run_id": stale_run_id,
                "latest_run_id": recent_run_id,
                "queue": queue,
                "status": "queue_unavailable" if queue.get("error") else "ok",
                "error": str(queue.get("error") or ""),
                "workers": _worker_summary(project_config, active_run_id),
            }
        )
    return projects


def _verify_summary(task_dir: Path) -> dict[str, Any]:
    verify = _read_json(task_dir / "verify.json")
    results = []
    for item in verify.get("results") or []:
        if not isinstance(item, dict):
            continue
        results.append(
            {
                "command": str(item.get("command") or ""),
                "ok": bool(item.get("ok")),
                "returncode": item.get("returncode"),
                "timed_out": bool(item.get("timed_out")),
                "duration_seconds": item.get("duration_seconds"),
                "stdout_path": str(item.get("stdout_path") or ""),
                "stderr_path": str(item.get("stderr_path") or ""),
            }
        )
    return {
        "status": str(verify.get("status") or ""),
        "ok": bool(verify.get("ok")) if verify else False,
        "results": results,
    }


def _review_summary(task_dir: Path) -> dict[str, Any]:
    review = _read_yaml(task_dir / "review.yaml")
    findings = []
    for item in review.get("findings") or []:
        if not isinstance(item, dict):
            continue
        findings.append(
            {
                "priority": str(item.get("priority") or ""),
                "file": str(item.get("file") or ""),
                "line": str(item.get("line") or ""),
                "title": str(item.get("title") or ""),
                "recommendation": str(item.get("recommendation") or ""),
            }
        )
    return {
        "status": str(review.get("status") or ""),
        "message": str(review.get("message") or ""),
        "findings": findings,
        "tests_run": [str(item) for item in review.get("tests_run") or []],
    }


def _task_summaries(
    config: AutoDevConfig,
    run: dict[str, Any],
    *,
    queue_tasks: dict[str, dict[str, Any]] | None = None,
    read_artifact_files: bool = True,
) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    queue_tasks = queue_tasks or {}
    for outcome in ((run.get("loop") or {}).get("tasks") or []):
        if not isinstance(outcome, dict):
            continue
        task_id = str(outcome.get("task_id") or "")
        child_run_id = str(outcome.get("run_id") or "")
        try:
            safe_task_id = validate_task_id(task_id) if task_id else ""
        except ValueError:
            safe_task_id = ""
        task_dir = (
            run_paths(config.project.repo_root, child_run_id).tasks_dir / safe_task_id
            if safe_task_id and child_run_id
            else None
        )
        queue_task = queue_tasks.get(task_id) or {}
        queue_status = str(queue_task.get("status") or "")
        resolved_by_queue = bool(task_id and queue_status in TERMINAL_QUEUE_STATUSES and not bool(outcome.get("ok")))
        if resolved_by_queue:
            raw_queue_task = queue_task.get("raw") if isinstance(queue_task.get("raw"), dict) else queue_task
            completion_mode = str((raw_queue_task or {}).get("completion_mode") or "")
            display_status = (
                "manual_done"
                if queue_status == "done" and completion_mode != "autodev_reviewed"
                else queue_status
            )
        else:
            display_status = str(outcome.get("status") or "")
        summaries.append(
            {
                "task_id": task_id,
                "run_id": child_run_id,
                "status": str(outcome.get("status") or ""),
                "display_status": display_status,
                "queue_status": queue_status,
                "resolved_by_queue": resolved_by_queue,
                "ok": bool(outcome.get("ok")),
                "message": str(outcome.get("message") or ""),
                "commit": str(outcome.get("commit") or ""),
                "verify": (
                    _verify_summary(task_dir)
                    if task_dir and read_artifact_files
                    else {}
                ),
                "review": (
                    _review_summary(task_dir)
                    if task_dir and read_artifact_files
                    else {}
                ),
            }
        )
    return summaries


def _overview_status(
    queue: dict[str, Any],
    run: dict[str, Any],
    *,
    queue_tasks: dict[str, dict[str, Any]],
    has_active_run: bool,
    has_stale_run: bool,
    explicit_run: bool,
) -> dict[str, Any]:
    counts = queue.get("counts") or {}
    queue_error = str(queue.get("error") or "").strip()
    if queue_error:
        return {
            "status": "queue_unavailable",
            "next_action": f"队列读取失败，不能判断空闲/阻塞状态：{queue_error}",
            "p0": 0,
            "p1": 0,
        }
    if has_stale_run:
        return {
            "status": "stale_active",
            "next_action": "检测到 run/队列仍是运行态，但该项目没有匹配的存活 PID/heartbeat lease；请执行中断收口或 resume/block 当前任务",
            "p0": 0,
            "p1": 0,
        }
    if has_active_run or explicit_run:
        return {
            "status": _run_limit_projection(str(run.get("status") or "no_run"), run),
            "next_action": str(run.get("next_action") or ""),
            "p0": int(((run.get("summary") or {}).get("findings") or {}).get("p0") or 0),
            "p1": int(((run.get("summary") or {}).get("findings") or {}).get("p1") or 0),
        }
    if int(counts.get("blocked") or 0):
        return {"status": "queue_blocked", "next_action": "处理 blocked 队列任务", "p0": 0, "p1": 0}
    in_progress = queue.get("in_progress") or []
    if in_progress:
        task_labels = []
        for task_id in in_progress:
            normalized_task_id = str(task_id)
            owner = str((queue_tasks.get(normalized_task_id) or {}).get("owner") or "")
            task_labels.append(
                f"{normalized_task_id} (owner={owner})" if owner else normalized_task_id
            )
        return {
            "status": "manual_in_progress",
            "next_action": "外部处理中的队列任务: " + ", ".join(task_labels),
            "p0": 0,
            "p1": 0,
        }
    pending_count = int(counts.get("pending") or 0)
    if pending_count:
        next_task = str(queue.get("next") or "-")
        return {
            "status": "pending_work",
            "next_action": (
                f"队列有 {pending_count} 个待处理任务（pending，尚未被 Worker 领取；下一个：{next_task}）；"
                "若 Claude Code 或人工已接管，请先领取（claim），状态才会变为进行中（in_progress）"
            ),
            "p0": 0,
            "p1": 0,
        }
    return {"status": "idle", "next_action": "当前没有 AutoDev 运行或待处理任务", "p0": 0, "p1": 0}


def _collect_file_dashboard_data(
    config: AutoDevConfig,
    *,
    run_id: str = "",
    registry_path: str | Path | None = None,
    queue_port: QueuePort | None = None,
) -> dict[str, Any]:
    run_id = _validate_run_id(run_id)
    run_dirs = _run_dirs(config.project.repo_root)
    active_run_id, stale_run_id = _latest_active_run_ids(
        config.project.repo_root,
        run_dirs=run_dirs,
    )
    recent_run_id = run_dirs[0].name if run_dirs else ""
    selected_run_id = run_id or active_run_id or stale_run_id or recent_run_id
    paths = run_paths(config.project.repo_root, selected_run_id) if selected_run_id else None
    run = _read_yaml(paths.run_yaml) if paths else {}
    summary_path = paths.output_dir / "summary.md" if paths else Path()
    if paths and not summary_path.exists():
        summary_path = paths.run_dir / "summary.md"
    events = _tail_events(paths.events_jsonl) if paths else []
    queue, queue_tasks = _queue_snapshot(config, queue_port)
    current = run.get("current_task") or {}
    current_task_id = str(current.get("id") or "")
    current_queue_task = queue_tasks.get(current_task_id) or {}
    current_raw_task = (
        current_queue_task.get("raw")
        if isinstance(current_queue_task.get("raw"), dict)
        else current_queue_task
    )
    current_task_title = str(
        (current_raw_task or {}).get("title") or current_queue_task.get("title") or ""
    )
    explicit_run = bool(run_id)
    has_active_run = bool(active_run_id)
    has_stale_run = bool(stale_run_id)
    run_kind = (
        "selected"
        if explicit_run
        else "active"
        if has_active_run
        else "stale"
        if has_stale_run
        else "latest"
        if selected_run_id
        else "none"
    )
    overview = _overview_status(
        queue,
        run,
        queue_tasks=queue_tasks,
        has_active_run=has_active_run,
        has_stale_run=has_stale_run,
        explicit_run=explicit_run,
    )
    run_is_live = bool(selected_run_id and selected_run_id == active_run_id)
    run_status = str(run.get("status") or "")
    run_display_status, run_queue_status, run_resolved_by_queue = _terminal_queue_projection(
        run_status,
        current,
        queue_tasks,
    )
    if run_is_live:
        run_display_status = run_status
        run_resolved_by_queue = False
    elif not run_resolved_by_queue:
        run_display_status = _run_limit_projection(run_display_status, run)
    current_status = str(current.get("status") or "")
    current_display_status = run_display_status if run_resolved_by_queue else current_status
    try:
        host_policy = load_host_policy()
        host_capacity = (
            HostCapacityBroker(host_policy).snapshot()
            if host_policy is not None
            else uncontrolled_snapshot()
        ).to_dict()
    except HostCapacityError as exc:
        host_capacity = uncontrolled_snapshot().to_dict()
        host_capacity["error"] = str(exc)
    recent_runs = _recent_runs(config, queue_tasks=queue_tasks, run_dirs=run_dirs)
    dashboard_tasks = _dashboard_tasks(queue_tasks, recent_runs)
    current_run_visible = run_kind in {"active", "selected", "stale"}
    current_project_state = {
        "active_run_id": active_run_id,
        "stale_run_id": stale_run_id,
        "latest_run_id": recent_run_id,
        "queue": queue,
    }
    return {
        "projects": _project_cards(
            config,
            registry_path=registry_path,
            queue_port=queue_port,
            current_state=current_project_state,
        ),
        "queue": queue,
        "recent_runs": recent_runs,
        "run": run,
        "run_duration": _duration_label(
            run.get("started_at"),
            "" if run_is_live else run.get("updated_at"),
        ),
        "run_display_status": run_display_status,
        "run_queue_status": run_queue_status,
        "run_resolved_by_queue": run_resolved_by_queue,
        "current_task_display_status": current_display_status,
        "run_id": selected_run_id,
        "active_run_id": active_run_id,
        "stale_run_id": stale_run_id,
        "latest_run_id": recent_run_id,
        "run_kind": run_kind,
        "current_run_visible": current_run_visible,
        "has_active_run": has_active_run,
        "has_stale_run": has_stale_run,
        "current_task": current,
        "current_task_title": current_task_title,
        "events": events,
        "tasks": _task_summaries(config, run, queue_tasks=queue_tasks) if run else [],
        "execution": _execution_view(config, run, queue_tasks, is_live=run_is_live) if run else {},
        "worker_board": _worker_board(config, active_run_id, queue_tasks),
        "task_rows": dashboard_tasks,
        "actionable_tasks": _actionable_tasks(dashboard_tasks),
        "summary_markdown": _read_text(summary_path) if paths else "",
        "summary_path": str(summary_path) if paths and summary_path.exists() else "",
        "blocking": overview,
        "host_capacity": host_capacity,
    }


def _database_recent_runs(
    config: AutoDevConfig,
    records: list[dict[str, Any]],
    queue_tasks: dict[str, dict[str, Any]],
    live_run_ids: set[str],
    events_by_run_id: dict[str, list[dict[str, Any]]],
    *,
    limit: int = RUN_HISTORY_LIMIT,
) -> list[dict[str, Any]]:
    run_lookup = {
        str(record.get("run_id") or ""): dict(record.get("snapshot") or {})
        for record in records
        if str(record.get("run_id") or "")
    }
    entries: list[dict[str, Any]] = []
    child_run_ids: set[str] = set()
    for data in run_lookup.values():
        child_run_ids.update(
            str(item.get("run_id") or "")
            for item in ((data.get("loop") or {}).get("tasks") or [])
            if isinstance(item, dict) and str(item.get("run_id") or "")
        )
    by_run_id: dict[str, dict[str, Any]] = {}
    for record in records:
        data = dict(record.get("snapshot") or {})
        run_id = str(record.get("run_id") or data.get("run_id") or "")
        if not run_id:
            continue
        status = str(data.get("status") or record.get("status") or "")
        current_task = dict(data.get("current_task") or {})
        task_id = str(current_task.get("id") or "")
        queue_task = queue_tasks.get(task_id) or {}
        raw_task = (
            queue_task.get("raw")
            if isinstance(queue_task.get("raw"), dict)
            else queue_task
        )
        display_status, queue_status, resolved_by_queue = (
            _terminal_queue_projection(status, current_task, queue_tasks)
        )
        if not resolved_by_queue:
            display_status = _run_limit_projection(display_status, data)
        is_live = run_id in live_run_ids and _is_active_run_status(status)
        children = [
            str(item.get("run_id") or "")
            for item in ((data.get("loop") or {}).get("tasks") or [])
            if isinstance(item, dict) and str(item.get("run_id") or "")
        ]
        entry = {
            "run_id": run_id,
            "status": status,
            "display_status": (
                "not_started"
                if status in START_CONDITION_STATUSES
                else display_status
            ),
            "queue_status": queue_status,
            "resolved_by_queue": resolved_by_queue,
            "started_at": str(data.get("started_at") or ""),
            "updated_at": str(
                data.get("updated_at") or record.get("updated_at") or ""
            ),
            "updated_at_display": _timestamp_label(
                data.get("updated_at") or record.get("updated_at")
            ),
            "duration": _duration_label(
                data.get("started_at"),
                "" if is_live else data.get("updated_at"),
            ),
            "is_live": is_live,
            "current_task": current_task,
            "task_title": str(
                (raw_task or {}).get("title")
                or queue_task.get("title")
                or ""
            ),
            "stages": _stage_timeline_from_events(
                events_by_run_id.get(run_id) or [],
                data,
            ),
            "child_run_ids": children,
            "child_runs": [],
            "execution": _execution_view(
                config,
                data,
                queue_tasks,
                is_live=is_live,
                run_lookup=run_lookup,
            ),
            "is_loop": data.get("loop") is not None,
            "start_condition_unmet": status in START_CONDITION_STATUSES,
            "successor_run_id": "",
            "recovery_status": "",
            "attempt_runs": [],
        }
        by_run_id[run_id] = entry
        entries.append(entry)
    for entry in entries:
        entry["child_runs"] = [
            by_run_id[child_id]
            for child_id in entry["child_run_ids"]
            if child_id in by_run_id
        ]
    logical = [
        entry
        for entry in entries
        if entry["is_loop"] or entry["run_id"] not in child_run_ids
    ]
    return logical[:limit]


def _database_page_event_run_ids(
    config: AutoDevConfig,
    snapshot: dict[str, Any],
    *,
    page: int,
    status_filter: str,
) -> set[str]:
    """Select only the visible Runs whose bounded event windows are needed."""
    records = [
        dict(item)
        for item in snapshot.get("runs") or []
        if isinstance(item, dict)
    ]
    queue_tasks = {
        str(task.get("id") or ""): dict(task)
        for task in snapshot.get("queue_tasks") or []
        if isinstance(task, dict) and str(task.get("id") or "")
    }
    live_run_ids = {
        str(item)
        for item in snapshot.get("live_run_ids") or []
        if str(item)
    }
    entries = _database_recent_runs(
        config,
        records,
        queue_tasks,
        live_run_ids,
        {},
    )
    filtered = [
        item
        for item in entries
        if _run_matches_filter(item, status_filter)
    ]
    page_count = max(
        1,
        (len(filtered) + RUN_PAGE_SIZE - 1) // RUN_PAGE_SIZE,
    )
    effective_page = min(max(1, page), page_count)
    start = (effective_page - 1) * RUN_PAGE_SIZE
    visible = filtered[start : start + RUN_PAGE_SIZE]
    run_ids: set[str] = set()
    for item in visible:
        run_id = str(item.get("run_id") or "")
        if run_id:
            run_ids.add(run_id)
        run_ids.update(
            str(child_id)
            for child_id in item.get("child_run_ids") or []
            if str(child_id)
        )
        run_ids.update(
            str(attempt.get("run_id") or "")
            for attempt in item.get("attempt_runs") or []
            if isinstance(attempt, dict)
            and str(attempt.get("run_id") or "")
        )
    return run_ids


def _database_worker_board(
    config: AutoDevConfig,
    snapshot: dict[str, Any],
    queue_tasks: dict[str, dict[str, Any]],
    run_lookup: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    hard_limit = 3
    configured = max(
        1,
        min(hard_limit, int(config.execution.max_parallel_tasks or 1)),
    )
    workers: list[dict[str, Any]] = []
    for item in snapshot.get("workers") or []:
        run_id = str(item.get("run_id") or "")
        run = run_lookup.get(run_id) or {}
        current = run.get("current_task") or {}
        task_id = str(current.get("id") or "")
        queue_task = queue_tasks.get(task_id) or {}
        raw_task = (
            queue_task.get("raw")
            if isinstance(queue_task.get("raw"), dict)
            else queue_task
        )
        models = _stage_agent_models(run)
        workers.append(
            {
                "worker_id": str(item.get("worker_id") or ""),
                "task_id": task_id,
                "task_title": str(
                    (raw_task or {}).get("title")
                    or queue_task.get("title")
                    or ""
                ),
                "child_run_id": run_id,
                "status": str(run.get("status") or item.get("status") or ""),
                "pid": int(item.get("pid") or 0),
                "alive": True,
                "builder": models.get("builder", ""),
                "evaluator": models.get("review", ""),
                "historical": False,
            }
        )
    slots: list[dict[str, Any]] = []
    for index in range(hard_limit):
        if index < len(workers):
            slot = dict(workers[index])
            slot.update({"slot": index + 1, "enabled": True, "occupied": True})
        elif index < configured:
            slot = {
                "slot": index + 1,
                "worker_id": f"worker-{index + 1:02d}",
                "status": "worker_idle",
                "enabled": True,
                "occupied": False,
            }
        else:
            slot = {
                "slot": index + 1,
                "worker_id": f"worker-{index + 1:02d}",
                "status": "disabled",
                "enabled": False,
                "occupied": False,
            }
        slots.append(slot)
    landing = [
        {
            "task_id": str(item.get("task_id") or ""),
            "child_run_id": str(item.get("run_id") or ""),
            "status": (
                "candidate_ready"
                if item.get("state") == "prepared"
                else "landing_finalize_pending"
            ),
            "ok": False,
        }
        for item in snapshot.get("landings") or []
    ]
    return {
        "concurrency": configured,
        "hard_limit": hard_limit,
        "active": len(workers),
        "workers": slots,
        "landing": landing,
        "historical": False,
        "persistent": True,
    }


def _collect_database_dashboard_data(
    config: AutoDevConfig,
    snapshot: dict[str, Any],
    *,
    run_id: str = "",
) -> dict[str, Any]:
    records = [
        dict(item)
        for item in snapshot.get("runs") or []
        if isinstance(item, dict)
    ]
    run_lookup = {
        str(item.get("run_id") or ""): dict(item.get("snapshot") or {})
        for item in records
        if str(item.get("run_id") or "")
    }
    live_run_ids = {
        str(item) for item in snapshot.get("live_run_ids") or [] if str(item)
    }
    active_run_id = next(
        (
            str(item.get("run_id") or "")
            for item in records
            if str(item.get("run_id") or "") in live_run_ids
            and _is_active_run_status(
                str(
                    (item.get("snapshot") or {}).get("status")
                    or item.get("status")
                    or ""
                )
            )
        ),
        "",
    )
    stale_run_id = next(
        (
            str(item.get("run_id") or "")
            for item in records
            if _is_active_run_status(
                str(
                    (item.get("snapshot") or {}).get("status")
                    or item.get("status")
                    or ""
                )
            )
            and str(item.get("run_id") or "") not in live_run_ids
        ),
        "",
    )
    latest_run_id = str(records[0].get("run_id") or "") if records else ""
    selected = snapshot.get("selected_run") or {}
    selected_run_id = str(
        selected.get("run_id")
        or run_id
        or active_run_id
        or stale_run_id
        or latest_run_id
    )
    run = dict(selected.get("snapshot") or {})
    if selected_run_id and not run:
        run = dict(run_lookup.get(selected_run_id) or {})
    queue = dict(snapshot.get("queue") or {})
    queue_tasks = {
        str(task.get("id") or ""): dict(task)
        for task in snapshot.get("queue_tasks") or []
        if isinstance(task, dict) and str(task.get("id") or "")
    }
    current = dict(run.get("current_task") or {})
    current_task_id = str(current.get("id") or "")
    current_queue_task = queue_tasks.get(current_task_id) or {}
    current_raw_task = (
        current_queue_task.get("raw")
        if isinstance(current_queue_task.get("raw"), dict)
        else current_queue_task
    )
    explicit_run = bool(run_id)
    has_active_run = bool(active_run_id)
    has_stale_run = bool(stale_run_id)
    run_kind = (
        "selected"
        if explicit_run
        else "active"
        if has_active_run
        else "stale"
        if has_stale_run
        else "latest"
        if selected_run_id
        else "none"
    )
    overview = _overview_status(
        queue,
        run,
        queue_tasks=queue_tasks,
        has_active_run=has_active_run,
        has_stale_run=has_stale_run,
        explicit_run=explicit_run,
    )
    run_status = str(run.get("status") or "")
    run_is_live = bool(
        selected_run_id
        and selected_run_id == active_run_id
        and _is_active_run_status(run_status)
    )
    run_display_status, run_queue_status, run_resolved_by_queue = (
        _terminal_queue_projection(run_status, current, queue_tasks)
    )
    if run_is_live:
        run_display_status = run_status
        run_resolved_by_queue = False
    elif not run_resolved_by_queue:
        run_display_status = _run_limit_projection(run_display_status, run)
    current_status = str(current.get("status") or "")
    recent_runs = _database_recent_runs(
        config,
        records,
        queue_tasks,
        live_run_ids,
        {
            str(key): list(value or [])
            for key, value in (
                snapshot.get("run_events") or {}
            ).items()
        },
    )
    dashboard_tasks = _dashboard_tasks(queue_tasks, recent_runs)
    summary_artifact = next(
        (
            item
            for item in snapshot.get("artifacts") or []
            if str(item.get("logical_name") or "") == "summary.md"
        ),
        {},
    )
    return {
        "projects": list(snapshot.get("projects") or []),
        "queue": queue,
        "recent_runs": recent_runs,
        "run": run,
        "run_duration": _duration_label(
            run.get("started_at"),
            "" if run_is_live else run.get("updated_at"),
        ),
        "run_display_status": run_display_status,
        "run_queue_status": run_queue_status,
        "run_resolved_by_queue": run_resolved_by_queue,
        "current_task_display_status": (
            run_display_status if run_resolved_by_queue else current_status
        ),
        "run_id": selected_run_id,
        "active_run_id": active_run_id,
        "stale_run_id": stale_run_id,
        "latest_run_id": latest_run_id,
        "run_kind": run_kind,
        "current_run_visible": run_kind in {"active", "selected", "stale"},
        "has_active_run": has_active_run,
        "has_stale_run": has_stale_run,
        "current_task": current,
        "current_task_title": str(
            (current_raw_task or {}).get("title")
            or current_queue_task.get("title")
            or ""
        ),
        "events": list(snapshot.get("events") or []),
        "tasks": (
            _task_summaries(
                config,
                run,
                queue_tasks=queue_tasks,
                read_artifact_files=False,
            )
            if run
            else []
        ),
        "execution": (
            _execution_view(
                config,
                run,
                queue_tasks,
                is_live=run_is_live,
                run_lookup=run_lookup,
            )
            if run
            else {}
        ),
        "worker_board": _database_worker_board(
            config,
            snapshot,
            queue_tasks,
            run_lookup,
        ),
        "task_rows": dashboard_tasks,
        "actionable_tasks": _actionable_tasks(dashboard_tasks),
        "summary_markdown": "",
        "summary_path": str(summary_artifact.get("uri") or ""),
        "blocking": overview,
        "host_capacity": dict(snapshot.get("host_capacity") or {}),
    }


def _load_database_dashboard_snapshot(
    config: AutoDevConfig,
    *,
    run_id: str = "",
    run_page: int = 1,
    run_status_filter: str = "all",
) -> dict[str, Any]:
    from autodev.database.config import MODE_DATABASE, load_database_config
    from autodev.database.cutover import (
        covered_project_ids,
        enforce_cutover_project,
        load_cutover_receipt,
    )
    from autodev.database.dashboard_repository import DatabaseDashboardReader
    from autodev.database.engine import Database
    from autodev.database.health import check_database_health
    from autodev.persistence import PersistenceUnavailableError

    database_config = load_database_config()
    if database_config.mode != MODE_DATABASE:
        raise RuntimeError("database dashboard requires persistence mode 'database'")
    receipt = load_cutover_receipt()
    if receipt is None:
        raise RuntimeError("database dashboard requires an active cutover receipt")
    enforce_cutover_project(config.project.id, config.project.repo_root)
    authorized_project_keys = covered_project_ids(receipt)
    database = Database.from_config(database_config)
    try:
        health = check_database_health(database, database_config)
        if not health.ok:
            detail = health.error or "database health check failed"
            raise PersistenceUnavailableError(
                f"database dashboard unavailable: {detail}"
            )
        reader = DatabaseDashboardReader(database)
        snapshot = reader.read(
            config.project.id,
            run_id=run_id,
            recent_limit=RUN_HISTORY_LIMIT,
            include_recent_events=False,
            authorized_project_keys=authorized_project_keys,
        )
        page_run_ids = _database_page_event_run_ids(
            config,
            snapshot,
            page=run_page,
            status_filter=run_status_filter,
        )
        if page_run_ids:
            page_events = reader.read_run_events(
                config.project.id,
                page_run_ids,
                authorized_project_keys=authorized_project_keys,
            )
            snapshot.setdefault("run_events", {}).update(page_events)
        return snapshot
    finally:
        database.dispose()


def collect_dashboard_data(
    config: AutoDevConfig,
    *,
    run_id: str = "",
    run_page: int = 1,
    run_status_filter: str = "all",
    registry_path: str | Path | None = None,
    queue_port: QueuePort | None = None,
) -> dict[str, Any]:
    from autodev.database.config import (
        MODE_DATABASE,
        VALID_MODES,
        requested_persistence_mode,
    )

    mode = requested_persistence_mode()
    if mode == MODE_DATABASE:
        snapshot = _load_database_dashboard_snapshot(
            config,
            run_id=run_id,
            run_page=run_page,
            run_status_filter=run_status_filter,
        )
        return _collect_database_dashboard_data(
            config,
            snapshot,
            run_id=run_id,
        )
    if mode is not None and mode not in VALID_MODES:
        from autodev.database.config import load_database_config

        load_database_config()
    return _collect_file_dashboard_data(
        config,
        run_id=run_id,
        registry_path=registry_path,
        queue_port=queue_port,
    )


def _e(value: Any) -> str:
    if value is None:
        return ""
    return html.escape(str(value), quote=True)


# 状态 → (中文标签, 色调)。色调语义与旧版 good/active/bad/muted 对齐，另拆出 violet/amber 两档。
_STATUS_META: dict[str, tuple[str, str]] = {
    "ok": ("正常", "green"),
    "done": ("已完成", "green"),
    "passed": ("通过", "green"),
    "pass": ("通过", "green"),
    "green": ("通过", "green"),
    "yellow": ("有保留", "amber"),
    "on_track": ("正常推进", "green"),
    "max_tasks_reached": ("本轮任务数已处理完", "green"),
    "batch_task_limit_completed": ("本轮任务数已处理完", "green"),
    "batch_finished_with_blocks": ("本轮结束·存在阻塞", "red"),
    "no_ready_task": ("无就绪任务", "green"),
    "resolved": ("已收口", "green"),
    "idle": ("Harness 空闲", "green"),
    "worker_idle": ("槽位空闲", "green"),
    "running": ("运行中", "blue"),
    "builder_running": ("构建运行中", "blue"),
    "waiting_capacity": ("等待本机容量", "amber"),
    "waiting_provider": ("等待模型容量", "amber"),
    "candidate_ready": ("等待串行落地", "violet"),
    "landing_verifying": ("落地前校验", "blue"),
    "landing_waiting_provider": ("落地复审排队", "amber"),
    "landing_finalize_pending": ("落地待调和", "red"),
    "in_progress": ("进行中", "blue"),
    "reviewing": ("评审中", "blue"),
    "verifying": ("校验中", "blue"),
    "building": ("构建中", "blue"),
    "committing": ("提交中", "blue"),
    "direction_checking": ("方向检查中", "blue"),
    "manual_in_progress": ("外部处理中", "blue"),
    "pending_work": ("有待处理任务", "amber"),
    "proposed": ("已提议", "violet"),
    "pending": ("待处理·尚未领取", "amber"),
    "not_started": ("未启动", "amber"),
    "recovered": ("已接续", "blue"),
    "recovered_running": ("已恢复运行", "blue"),
    "recovered_done": ("已恢复完成", "green"),
    "manual_done": ("已完成·外部收口", "green"),
    "retry_source_required": ("需基于上次修复", "red"),
    "retry_source_invalid": ("续修来源无效", "red"),
    "failure_budget_exhausted": ("同一任务重试次数已用完", "red"),
    "time_budget_exhausted": ("本轮运行时长已用完", "amber"),
    "token_budget_exhausted": ("模型 Token 预算已用完", "red"),
    "context_token_limit": ("模型上下文 Token 超限", "red"),
    "agent_quota_exhausted": ("模型账号用量额度已用完", "red"),
    "rate_limit_exceeded": ("模型调用频率受限", "amber"),
    "queue_capacity_full": ("队列并行槽位已满", "amber"),
    "retry_patch_failed": ("候选恢复失败", "red"),
    "preflight": ("预检中", "blue"),
    "preflight_failed": ("预检失败", "red"),
    "selected": ("已选择", "blue"),
    "selecting": ("选择 Agent 中", "blue"),
    "building_prompt": ("生成提示词中", "blue"),
    "agent_selection_failed": ("Agent 选择失败", "red"),
    "worktree_failed": ("工作树创建失败", "red"),
    "builder_blocked": ("构建受阻", "red"),
    "builder_failed": ("构建失败", "red"),
    "builder_no_result": ("构建无结果", "red"),
    "builder_timeout": ("构建超时", "red"),
    "builder_unavailable": ("构建 Agent 不可用", "red"),
    "verify_failed": ("校验失败", "red"),
    "review_diff_failed": ("评审差异读取失败", "red"),
    "review_candidate_changed": ("评审期间候选已变化", "red"),
    "safety_policy_red": ("安全策略未通过", "red"),
    "queue_contract_red": ("队列契约未通过", "red"),
    "commit_failed": ("提交失败", "red"),
    "landing_verify_failed": ("落地校验失败", "red"),
    "landing_review_failed": ("落地评审失败", "red"),
    "landing_review_red": ("落地评审未通过", "red"),
    "landing_safety_policy_red": ("落地安全策略未通过", "red"),
    "landing_state_invalid": ("落地状态无效", "red"),
    "landing_capacity_failed": ("落地容量申请失败", "red"),
    "landing_reconcile_required": ("落地需要调和", "red"),
    "integration_conflict": ("集成冲突", "red"),
    "integration_cas_failed": ("集成并发校验失败", "red"),
    "queue_not_committed_to_base": ("队列未提交到基线", "amber"),
    "workspace_queue_stale": ("工作区队列不是最新版本", "amber"),
    "provider_capacity_failed": ("模型容量申请失败", "red"),
    "host_capacity_invalid": ("本机容量配置无效", "red"),
    "host_policy_required": ("缺少本机容量策略", "red"),
    "worker_process_error": ("Worker 进程异常", "red"),
    "system_error": ("系统错误", "red"),
    "queue_error": ("队列错误", "red"),
    "loop_already_running": ("任务循环已在运行", "amber"),
    "notifications_config_invalid": ("通知配置无效", "red"),
    "dry_run": ("演练模式", "slate"),
    "sent": ("已发送", "green"),
    "already_pending": ("已经待处理", "amber"),
    "direction_blocked": ("方向检查阻塞", "red"),
    "consecutive_failures_stop": ("连续失败触发停止", "red"),
    "retry_resume_failed": ("续修恢复失败", "red"),
    "cancelled_by_breaker": ("被熔断器取消", "red"),
    "global_stop_file": ("全局停止文件已触发", "amber"),
    "stop_file": ("项目停止文件已触发", "amber"),
    "warning": ("警告", "amber"),
    "blocked": ("已阻塞", "red"),
    "failed": ("失败", "red"),
    "fail": ("失败", "red"),
    "red": ("评审未过", "red"),
    "review_red": ("评审未过", "red"),
    "error": ("错误", "red"),
    "direction_drift": ("方向漂移", "red"),
    "blocking_findings": ("阻塞发现", "red"),
    "failed_worktree_dirty": ("工作树脏", "red"),
    "queue_blocked": ("队列阻塞", "red"),
    "queue_unavailable": ("队列不可用", "red"),
    "stale_active": ("中断残留", "red"),
    "registry_error": ("注册表错误", "red"),
    "interrupted": ("已中断", "slate"),
    "disabled": ("已禁用", "slate"),
    "skipped": ("已跳过", "slate"),
    "info": ("信息", "slate"),
    "no_run": ("无运行", "slate"),
    "unknown": ("未知状态", "slate"),
    "starting": ("启动中", "blue"),
    "-": ("无记录", "slate"),
    "p0": ("P0", "red"),
    "p1": ("P1", "amber"),
    "p2": ("P2", "slate"),
}

_PHASE_ZH: dict[str, str] = {
    "preflight": "预检",
    "worktree": "工作树",
    "claim": "认领",
    "agent_selection": "Agent 选择",
    "prompt": "提示词",
    "builder": "构建",
    "evaluator": "评估",
    "review": "评审",
    "verify": "校验",
    "done": "完成",
}

# 每个 run 的「环节时间线」用到的三张表。
# 1) _STAGE_LABELS：环节键 → 中文标签（复用事件表 _PHASE_ZH 的措辞，两处一致）。
_STAGE_LABELS: dict[str, str] = {
    **_PHASE_ZH,
    "commit": "提交",
    "loop_start": "循环开始",
    "task": "子任务",
    "direction_check": "方向检查",
    "summary": "汇总",
    "queue": "队列",
    "handoff": "交接材料",
    "retry": "重试",
    "notification": "通知",
    "interrupted": "中断",
    "stop_archive": "归档",
    "dry_run": "演练",
    "system_error": "系统错误",
    "failure_classification": "失败归类",
    "block_non_retryable": "阻塞·不可重试",
    "circuit_breaker": "熔断",
    "steer": "校正",
    "budget": "预算",
    "stop": "停止",
    "notification_failed": "通知失败",
    "notifications_config_invalid": "通知配置无效",
    "loop_already_running": "循环已在运行",
}
# 2) _STAGE_PIPELINE_ORDER：单任务 run 的规范流水线顺序（左→右），未走到的环节显示「未进行」。
_STAGE_PIPELINE_ORDER: tuple[str, ...] = (
    "preflight",
    "worktree",
    "claim",
    "agent_selection",
    "prompt",
    "builder",
    "verify",
    "review",
    "commit",
    "done",
)
# 3) _RAW_STAGE_MAP：原始事件 phase → (规范环节键, 是否失败信号)。失败分支归并到同一环节并标红。
_RAW_STAGE_MAP: dict[str, tuple[str, bool]] = {
    "preflight": ("preflight", False),
    "preflight_failed": ("preflight", True),
    # 建构前的队列/基线门禁失败也归到「预检」这一步，避免变成未翻译的孤立节点。
    "queue_not_committed_to_base": ("preflight", True),
    "workspace_queue_stale": ("preflight", True),
    "retry_source_required": ("preflight", True),
    "retry_source_invalid": ("preflight", True),
    "failure_budget_exhausted": ("preflight", True),
    "worktree": ("worktree", False),
    "worktree_failed": ("worktree", True),
    "retry_restore": ("worktree", False),
    "retry_patch_failed": ("worktree", True),
    "claim": ("claim", False),
    "agent_selection": ("agent_selection", False),
    "prompt": ("prompt", False),
    "agent_selection_failed": ("agent_selection", True),
    "builder": ("builder", False),
    "builder_session_fallback": ("builder", False),
    "builder_failed": ("builder", True),
    "builder_blocked": ("builder", True),
    "builder_unavailable": ("builder", True),
    "builder_timeout": ("builder", True),
    "builder_no_result": ("builder", True),
    "verify": ("verify", False),
    "verify_failed": ("verify", True),
    "review": ("review", False),
    "review_red": ("review", True),
    "review_blocked": ("review", True),
    "review_diff_failed": ("review", True),
    "review_candidate_changed": ("review", True),
    "safety_policy_red": ("review", True),
    "queue_contract_red": ("review", True),
    "evaluator": ("review", False),
    "commit": ("commit", False),
    "commit_failed": ("commit", True),
    "done": ("done", False),
    "system_error": ("system_error", True),
    "notifications_config_invalid": ("notifications_config_invalid", True),
    "loop_already_running": ("loop_already_running", True),
    # loop 型 run（编排多子任务）的高层环节，非单任务流水线。
    "loop_start": ("loop_start", False),
    "task": ("task", False),
    "direction_check": ("direction_check", False),
    "summary": ("summary", False),
    "queue": ("queue", False),
    "retry": ("retry", False),
    "retry_cleanup": ("retry", False),
    "failure_classification": ("failure_classification", False),
    "block_non_retryable": ("block_non_retryable", True),
    "circuit_breaker": ("circuit_breaker", True),
    "steer": ("steer", False),
    "budget": ("budget", False),
    "stop": ("stop", False),
    "handoff": ("handoff", False),
    "notification": ("notification", False),
    "notification_failed": ("notification_failed", True),
    "interrupted": ("interrupted", True),
    "stop_archive": ("stop_archive", False),
    "dry_run": ("dry_run", False),
}
# 环节状态 → 色调 / 中文短标。
_STAGE_STATUS_TONE: dict[str, str] = {
    "done": "green",
    "running": "blue",
    "failed": "red",
    "pending": "slate",
    "not_started": "amber",
}
_STAGE_STATUS_ZH: dict[str, str] = {
    "done": "完成",
    "running": "进行中",
    "failed": "失败",
    "pending": "未进行",
    "not_started": "条件未满足",
}
# 收尾类环节不参与「当前进行到哪一步」的判定（它们总在最后追加）。
_STAGE_TAIL_PHASES: frozenset[str] = frozenset({"handoff", "notification"})
# 哪些环节由 LLM 执行 → 在该环节标注执行模型；agent_selection 里 builder / evaluator 各对应一步。
#   构建 builder = 写代码的模型；评审 review = 另一个独立复核的模型（codex_check / claude_check）。
_STAGE_AGENT_ROLE: dict[str, str] = {"builder": "builder", "review": "evaluator"}

_BUILDER_SESSION_ZH: dict[str, str] = {
    "fresh": "新会话",
    "resumed": "继续原会话",
    "fresh_fallback": "原会话失败·已换新会话",
}


def _agent_model_desc(spec: Any) -> str:
    """把 agent_selection 里的一个 agent（builder/evaluator）描述成「厂商 · 模型」，如 claude · opus。"""
    if not isinstance(spec, dict):
        return ""
    kind = str(spec.get("kind") or spec.get("name") or "").strip()
    args = spec.get("args") or []
    model = ""
    if isinstance(args, list):
        for index, arg in enumerate(args):
            text = str(arg)
            if text == "--model" and index + 1 < len(args):
                model = str(args[index + 1]).strip()
                break
            if text.startswith("--model="):
                model = text.split("=", 1)[1].strip()
                break
    if not model:
        model = str(spec.get("model") or "").strip()
    if not model:
        return kind
    if not kind:
        return model
    # 模型名已含厂商前缀（如 claude-fable-5）就不重复写厂商。
    if kind.lower() in model.lower() or model.lower() in kind.lower():
        return model
    return f"{kind} · {model}"


def _stage_agent_models(run_data: dict[str, Any]) -> dict[str, str]:
    """返回 {环节键: 模型描述}，供 builder / review 两步挂模型名。"""
    selection = (run_data.get("current_task") or {}).get("agent_selection") or run_data.get("agent_selection") or {}
    if not isinstance(selection, dict):
        return {}
    models: dict[str, str] = {}
    for stage_key, role in _STAGE_AGENT_ROLE.items():
        desc = _agent_model_desc(selection.get(role))
        if desc:
            models[stage_key] = desc
    return models


def _stage_timeline_from_events(
    events: list[dict[str, Any]],
    run_data: dict[str, Any],
) -> list[dict[str, Any]]:
    """从 Run 事件推导「环节 + 状态」时间线。

    - 单任务 run：按 _STAGE_PIPELINE_ORDER 铺满规范流水线，未走到的环节标「未进行」。
    - loop 型 run：按事件出现顺序展示高层环节（子任务流水线在各子 run 内）。
      loop 判定优先看 run.yaml 的 loop 字段（权威、不受事件尾窗截断影响），
      事件里的 loop_start 只作补充信号（长 loop 的 loop_start 可能被 80 条尾窗挤掉）。
    """
    if not events:
        return []
    run_status = str(run_data.get("status") or "")
    active = _is_active_run_status(run_status)
    start_condition_unmet = run_status in START_CONDITION_STATUSES
    # loop 型：run.yaml 里带 loop 结构 = 编排型 run；单任务 run 没有该字段。
    is_loop = run_data.get("loop") is not None
    seen: dict[str, dict[str, Any]] = {}
    order_seen: list[str] = []
    last_active_key = ""
    for event in events:
        raw = str(event.get("phase") or "").strip().lower()
        if not raw:
            continue
        if raw == "loop_start":
            is_loop = True
        key, is_fail = _RAW_STAGE_MAP.get(raw, (raw, False))
        record = seen.get(key)
        if record is None:
            record = {"failed": False, "message": "", "timestamp": ""}
            seen[key] = record
            order_seen.append(key)
        # 失败态取「最新事件」而非累积或——同一环节键被重试恢复后应回到成功态（loop 的 task 会复用键）。
        record["failed"] = is_fail or str(event.get("level") or "").strip().lower() == "error"
        record["message"] = str(event.get("message") or "")
        record["timestamp"] = str(event.get("timestamp") or "")
        # 「当前进行到哪一步」= 时间上最后一个非收尾事件所在的环节。
        if key not in _STAGE_TAIL_PHASES:
            last_active_key = key

    if is_loop:
        keys = list(order_seen)
        pad_pending = False
    else:
        keys = list(_STAGE_PIPELINE_ORDER)
        for key in order_seen:
            if key not in keys:
                keys.append(key)
        pad_pending = True

    stage_models = _stage_agent_models(run_data)
    builder_session = (run_data.get("current_task") or {}).get("builder_session") or {}
    builder_session_mode = (
        str(builder_session.get("mode") or "")
        if isinstance(builder_session, dict)
        else ""
    )
    stages: list[dict[str, Any]] = []
    for key in keys:
        # A loop-end direction review has no development result to inspect when
        # execution stopped before claim/builder. Hide that derived red node and
        # the internal classifier node so one operational condition is presented
        # as one clear, amber "not started" outcome.
        if start_condition_unmet and is_loop and key in {"direction_check", "failure_classification"}:
            continue
        record = seen.get(key)
        if record is None:
            if not pad_pending:
                continue
            status, message, timestamp = "pending", "", ""
        elif record["failed"]:
            status, message, timestamp = "failed", record["message"], record["timestamp"]
        elif active and key == last_active_key:
            status, message, timestamp = "running", record["message"], record["timestamp"]
        else:
            status, message, timestamp = "done", record["message"], record["timestamp"]
        if start_condition_unmet and status == "failed" and key in {"preflight", "task"}:
            status = "not_started"
        stages.append(
            {
                "key": key,
                "label": _STAGE_LABELS.get(key, key),
                "en": key,
                "status": status,
                "message": message,
                "timestamp": timestamp,
                # builder / review 两步挂执行模型名，其余步为空（校验是自动化测试，无模型）。
                "model": stage_models.get(key, ""),
                "session_mode": builder_session_mode if key == "builder" else "",
            }
        )
    return stages


def _run_stage_timeline(
    run_dir: Path,
    run_data: dict[str, Any],
) -> list[dict[str, Any]]:
    """从文件模式单个 Run 的 events.jsonl 推导阶段时间线。"""
    return _stage_timeline_from_events(
        _tail_events(run_dir / "events.jsonl"),
        run_data,
    )


_TONE_FG: dict[str, str] = {
    "green": "#157347",
    "blue": "#1d4ed8",
    "violet": "#6d28d9",
    "amber": "#b45309",
    "red": "#c0342e",
    "slate": "#586074",
}


def _status_meta(status: Any) -> tuple[str, str, str]:
    """Return (raw value, zh label, tone) for a status string."""
    value = str(status or "unknown")
    normalized = value.lower()
    meta = _STATUS_META.get(normalized)
    if meta is None:
        if normalized.endswith("_running"):
            meta = ("运行中", "blue")
        elif normalized.endswith("_failed"):
            meta = ("失败", "red")
        else:
            meta = ("未识别状态", "slate")
    return value, meta[0], meta[1]


def _pill(status: Any, *, large: bool = False) -> str:
    value, zh, tone = _status_meta(status)
    classes = f"pill pill-lg t-{tone}" if large else f"pill t-{tone}"
    dot = '<span class="dot"></span>' if large else ""
    en_html = f'<span class="en">{_e(value)}</span>' if zh != value else ""
    return f'<span class="{classes}">{dot}{_e(zh)}{en_html}</span>'


def _inline_status(status: Any) -> str:
    """Render a raw technical value with a small Chinese explanation."""
    value, zh, _ = _status_meta(status)
    zh_html = f'<span class="status-zh">（{_e(zh)}）</span>' if zh != value else ""
    return f'<span class="mono">{_e(value)}</span>{zh_html}'


def _limit_explanation(status: Any) -> str:
    explanations = {
        "batch_task_limit_completed": "本轮达到的是任务数量上限（max_tasks），不是 Token 或模型账号额度上限。",
        "batch_finished_with_blocks": "本轮已处理到任务数量上限（max_tasks），但其中有任务阻塞；不是 Token 上限。",
        "failure_budget_exhausted": "达到的是同一任务允许的失败/重试次数，不是 Token 上限。",
        "time_budget_exhausted": "达到的是本轮允许的运行时长，不是 Token 上限。",
        "token_budget_exhausted": "达到的是为本轮配置的模型 Token 使用预算。",
        "context_token_limit": "单次请求的上下文超过模型可接收的 Token 数。",
        "agent_quota_exhausted": "模型账号或订阅的用量额度已用完，不是单次上下文 Token 超限。",
        "rate_limit_exceeded": "单位时间内的模型请求过多，需要等待调用频率额度恢复。",
        "queue_capacity_full": "队列允许的并行任务槽位已占满，需要等待已有任务结束。",
        "waiting_capacity": "本机 Worker 并发槽位已占满，任务仍在等待。",
        "waiting_provider": "该模型供应方的并发槽位已占满，任务仍在等待。",
    }
    explanation = explanations.get(str(status or ""), "")
    return f'<div class="status-help">{_e(explanation)}</div>' if explanation else ""


def _phase_chip(phase: Any) -> str:
    value = str(phase or "")
    if not value:
        return ""
    zh = _PHASE_ZH.get(value.lower())
    if zh:
        return f'<span class="chip">{_e(zh)}<span class="en">{_e(value)}</span></span>'
    return f'<span class="chip">{_e(value)}</span>'


def _artifact_link(path: str) -> str:
    if not path:
        return ""
    escaped = _e(path)
    return f'<a href="{escaped}">{escaped}</a>'


def _counts_html(counts: dict[str, Any]) -> str:
    tiles = []
    for key in ("pending", "proposed", "in_progress", "blocked", "done", "skipped"):
        _, zh, tone = _status_meta(key)
        tiles.append(
            '<div class="tile">'
            f'<div class="n">{_e(counts.get(key, 0))}</div>'
            f'<div class="lab"><span class="dot" style="background:{_TONE_FG[tone]}"></span>'
            f'<span class="zh">{_e(zh)}</span></div>'
            f'<div class="en">{_e(key)}</div>'
            "</div>"
        )
    return "\n".join(tiles)


def _projects_html(projects: list[dict[str, Any]]) -> str:
    if not projects:
        return '<div class="empty">暂无项目</div>'
    rows = []
    for project in projects:
        counts = (project.get("queue") or {}).get("counts") or {}
        workers = project.get("workers") or {}
        run_label = "active" if project.get("active_run_id") else "stale" if project.get("stale_run_id") else "latest"

        def count_cell(key: str) -> str:
            return _e(counts.get(key, 0)) if counts else "—"

        rows.append(
            "<tr>"
            f"<td><div class=\"cell-main\">{_e(project.get('name'))}</div>"
            f"<div class=\"cell-sub\">{_e(project.get('id'))}</div></td>"
            f"<td>{_pill(project.get('status'))}</td>"
            f"<td class=\"num\">{_e(workers.get('active', 0))} / {_e(workers.get('limit', '—'))}</td>"
            f"<td class=\"num\">{count_cell('pending')}</td>"
            f"<td class=\"num\">{count_cell('in_progress')}</td>"
            f"<td class=\"num\">{count_cell('blocked')}</td>"
            f"<td class=\"num\">{count_cell('done')}</td>"
            f"<td><div class=\"mono\" style=\"font-size:12px;word-break:break-all\">{_e(project.get('current_run_id') or '—')}</div>"
            f"<div class=\"cell-sub\">{_e(run_label)}</div></td>"
            f"<td class=\"mono\" style=\"font-size:12px;color:#586074;word-break:break-all\">{_e(project.get('error') or project.get('repo_root') or project.get('config_path'))}</td>"
            "</tr>"
        )
    return (
        '<div class="scroll-x"><table style="min-width:840px"><thead><tr>'
        "<th>项目 project</th><th>状态 status</th><th class=\"num\">Worker</th><th class=\"num\">待处理</th><th class=\"num\">运行中</th>"
        "<th class=\"num\">阻塞</th><th class=\"num\">完成</th><th>运行 run</th><th>路径 / 错误</th>"
        "</tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table></div>"
    )


def _capacity_html(capacity: dict[str, Any]) -> str:
    if not capacity.get("controlled"):
        detail = capacity.get("error") or "未配置 XDG host policy；当前为不受控兼容模式"
        return f'<div class="empty">全局容量未启用 / uncontrolled<br><span class="mono">{_e(detail)}</span></div>'
    providers = capacity.get("provider_limits") or {}
    occupied = capacity.get("provider_occupied") or {}
    provider_text = " · ".join(
        f"{name} {occupied.get(name, 0)}/{limit}"
        for name, limit in sorted(providers.items())
    ) or "未配置 provider 上限"
    return (
        '<div class="run-stats">'
        f'<span><span class="k">本机 occupied</span>= <span class="m">{_e(capacity.get("occupied", 0))}/{_e(capacity.get("max_active_workers", 0))}</span></span>'
        f'<span><span class="k">活动 live</span>= <span class="m">{_e(capacity.get("live", 0))}</span></span>'
        f'<span><span class="k">孤儿 orphan</span>= <span class="m">{_e(capacity.get("orphan", 0))}</span></span>'
        f'<span><span class="k">待调和</span>= <span class="m">{_e(capacity.get("needs_reconcile", 0))}</span></span>'
        '</div>'
        f'<div class="kv-foot"><span class="m">{_e(provider_text)}</span></div>'
    )


def _execution_html(execution: dict[str, Any], *, compact: bool = False) -> str:
    workers = execution.get("workers") or []
    landing = execution.get("landing") or []
    concurrency = int(execution.get("concurrency") or 0)
    persistent = bool(execution.get("persistent"))
    if not workers and not concurrency and not landing and not persistent:
        return ""
    worker_cards = []
    for worker in workers:
        models = " · ".join(
            part
            for part in (
                f"构建：{worker.get('builder')}" if worker.get("builder") else "",
                f"评审：{worker.get('evaluator')}" if worker.get("evaluator") else "",
            )
            if part
        )
        disabled = not bool(worker.get("enabled", True))
        occupied = bool(worker.get("occupied", worker.get("task_id")))
        card_class = " worker-disabled" if disabled else (" worker-idle" if not occupied else "")
        if disabled:
            title = f"未启用：当前并发配置上限为 {concurrency}"
            run_meta = "提高项目与本机并发配置后才可使用"
        elif not occupied:
            title = "空闲，可领取下一个就绪任务"
            run_meta = "当前没有分配任务"
        else:
            title = str(worker.get("task_title") or "未记录任务标题")
            run_meta = f'子运行：<span class="mono">{_e(worker.get("child_run_id") or "—")}</span>'
        worker_cards.append(
            f'<article class="worker-card{card_class}">'
            '<div class="worker-head">'
            f'<span class="mono worker-name">WORKER {int(worker.get("slot") or len(worker_cards) + 1):02d}</span>'
            f'{_pill(worker.get("status"))}'
            '</div>'
            f'<div class="worker-task">{_e(worker.get("task_id") or "—")}</div>'
            f'<div class="worker-title">{_e(title)}</div>'
            f'<div class="worker-meta">{run_meta}</div>'
            f'<div class="worker-meta">{_e(models or ("—" if disabled or not occupied else "未记录 Agent / 模型"))}</div>'
            f'<div class="worker-meta">槽位标识：<span class="mono">{_e(worker.get("worker_id") or "—")}</span></div>'
            '</article>'
        )
    if not execution.get("historical"):
        for slot in range(len(workers), concurrency):
            worker_cards.append(
                '<article class="worker-card worker-idle">'
                f'<div class="worker-head"><span class="mono worker-name">worker-slot-{slot + 1:02d}</span>{_pill("idle")}</div>'
                '<div class="worker-task">—</div><div class="worker-title">空闲，可领取下一个就绪任务</div>'
                '</article>'
            )
    landing_items = "".join(
        '<span class="landing-item">'
        f'<span class="mono">{_e(item.get("task_id") or "—")}</span>{_pill(item.get("status"))}'
        '</span>'
        for item in landing
    ) or '<span class="landing-empty">尚无任务进入落地通道</span>'
    mode = "历史 Worker 映射" if execution.get("historical") else "Worker 并发槽位"
    compact_class = " execution-compact" if compact else ""
    hard_limit = int(execution.get("hard_limit") or concurrency or len(workers))
    if persistent:
        capacity_text = f'活动 {int(execution.get("active") or 0)}/{concurrency} · 系统硬上限 {hard_limit}'
    else:
        capacity_text = f'{len(workers)} / {concurrency or len(workers)}'
    return (
        f'<div class="execution-board{compact_class}">'
        f'<div class="execution-meta"><strong>{_e(mode)}</strong><span>Worker 与任务一一对应；Worker 编号仅在本次逻辑 Run 内有效</span>'
        f'<span class="mono">{_e(capacity_text)}</span></div>'
        f'<div class="worker-grid">{"".join(worker_cards)}</div>'
        '<div class="landing-lane"><span class="landing-label">串行落地通道 <small>landing lane</small></span>'
        f'<div class="landing-items">{landing_items}</div></div>'
        '</div>'
    )


def _events_html(events: list[dict[str, Any]]) -> str:
    if not events:
        return '<div class="empty">暂无事件</div>'
    rows = []
    for event in events:
        rows.append(
            "<tr>"
            f"<td class=\"mono\" style=\"font-size:12px;color:#586074;white-space:nowrap\">{_e(event.get('timestamp'))}</td>"
            f"<td>{_pill(event.get('level'))}</td>"
            f"<td>{_phase_chip(event.get('phase'))}</td>"
            f"<td class=\"mono\" style=\"font-size:12.5px\">{_e(event.get('task_id') or '—')}</td>"
            f"<td>{_e(event.get('message'))}</td>"
            f"<td class=\"mono\" style=\"font-size:12px;word-break:break-all\">{_artifact_link(str(event.get('artifact') or ''))}</td>"
            "</tr>"
        )
    return (
        '<div class="scroll-x"><table style="min-width:960px"><thead><tr>'
        "<th>时间 time</th><th>级别 level</th><th>阶段 phase</th><th>任务 task</th><th>消息 message</th><th>产物 artifact</th>"
        "</tr></thead><tbody>" + "".join(rows) + "</tbody></table></div>"
    )


_STAGE_TITLE_MSG_LIMIT = 160


def _stage_title(stage: dict[str, Any]) -> str:
    timestamp = str(stage.get("timestamp") or "")
    message = str(stage.get("message") or "")
    if len(message) > _STAGE_TITLE_MSG_LIMIT:
        message = message[:_STAGE_TITLE_MSG_LIMIT] + "…"
    return " · ".join(part for part in (timestamp, message) if part)


def _run_stages_html(stages: list[dict[str, Any]]) -> str:
    if not stages:
        return '<div class="stage-empty">暂无环节记录 · no stage events</div>'
    nodes = []
    for stage in stages:
        status = str(stage.get("status") or "pending")
        tone = _STAGE_STATUS_TONE.get(status, "slate")
        has_model = " step-agent" if stage.get("model") else ""
        extra = " step-pending" if status == "pending" else (" step-running" if status == "running" else "")
        title = _e(_stage_title(stage))
        title_attr = f' title="{title}"' if title else ""
        model = str(stage.get("model") or "")
        # builder / review 两步把执行模型名单独放一行；review 加「模型复核」前缀，点明是另一个模型在检查。
        if model:
            prefix = "模型复核 · " if stage.get("key") == "review" else ""
            model_html = f'<span class="smodel">{_e(prefix + model)}</span>'
        else:
            model_html = ""
        session_mode = str(stage.get("session_mode") or "")
        session_label = _BUILDER_SESSION_ZH.get(session_mode, "")
        session_html = (
            f'<span class="ssession">{_e(session_label)}<span class="en">{_e(session_mode)}</span></span>'
            if session_label
            else ""
        )
        state_label = "已生成" if stage.get("key") == "handoff" and status == "done" else _STAGE_STATUS_ZH.get(status, status)
        nodes.append(
            f'<div class="step t-{tone}{has_model}{extra}"{title_attr}>'
            '<span class="sdot"></span>'
            f'<span class="slabel">{_e(stage.get("label"))}<span class="en">{_e(stage.get("en"))}</span>{model_html}{session_html}</span>'
            f'<span class="sstate">{_e(state_label)}</span>'
            "</div>"
        )
    return '<div class="stepper">' + "".join(nodes) + "</div>"


def _recent_runs_html(recent: list[dict[str, Any]]) -> str:
    if not recent:
        return '<div class="empty">暂无最近 run · no recent runs</div>'

    def start_condition_notice(item: dict[str, Any]) -> str:
        if not item.get("start_condition_unmet"):
            return ""
        successor_run_id = str(item.get("successor_run_id") or "")
        if successor_run_id:
            recovery = _pill(item.get("recovery_status") or "recovered")
            action = (
                f"队列提交后，已由 <span class=\"mono\">{_e(successor_run_id)}</span> 接续。{recovery}"
            )
        elif item.get("recovery_status") == "recovered_done":
            action = f"队列当前已经收口。{_pill('recovered_done')}"
        elif item.get("recovery_status") == "recovered_running":
            action = f"队列显示任务已重新进入运行态。{_pill('recovered_running')}"
        else:
            action = "请先把队列提交到基线分支，再重新运行。"
        return (
            '<div class="notice warn">'
            "启动条件未满足：任务尚未进入本次 Git 基线，因此未认领任务、未调用 AI、未消耗重试次数。"
            f"{action}<br>技术状态：{_inline_status(item.get('status'))}"
            "</div>"
        )

    def child_runs_html(children: list[dict[str, Any]]) -> str:
        if not children:
            return ""
        cards = []
        for child in children:
            child_stages = child.get("stages") or []
            child_done = sum(1 for stage in child_stages if str(stage.get("status")) == "done")
            child_counter = f'<span class="rs-n">{child_done}/{len(child_stages)}</span>' if child_stages else ""
            child_status = (
                "not_started"
                if child.get("start_condition_unmet")
                else child.get("display_status") or child.get("status")
            )
            cards.append(
                f'<div class="child-run" data-child-run="{_e(child.get("run_id"))}">'
                '<div class="child-run-head">'
                '<span><span class="k">子运行 · task run</span> '
                f'<span class="mono">{_e(child.get("run_id"))}</span></span>'
                f'{_pill(child_status)}'
                "</div>"
                f'<div class="child-worker">Worker：<span class="mono">{_e(child.get("worker_id") or "未记录")}</span>'
                f' · 任务：<span class="mono">{_e(child.get("worker_task_id") or (child.get("current_task") or {}).get("id") or "—")}</span></div>'
                f'<div class="rs-h">任务环节 · pipeline {child_counter}</div>'
                f'{_run_stages_html(child_stages)}'
                "</div>"
            )
        return (
            '<div class="child-runs"><div class="child-runs-title">子运行明细 · task runs</div>'
            + "".join(cards)
            + "</div>"
        )

    def attempt_runs_html(attempts: list[dict[str, Any]]) -> str:
        if not attempts:
            return ""
        cards = []
        for attempt in attempts:
            stages = attempt.get("stages") or []
            status = attempt.get("display_status") or attempt.get("status")
            cards.append(
                f'<div class="child-run" data-attempt-run="{_e(attempt.get("run_id"))}">'
                '<div class="child-run-head">'
                '<span><span class="k">历史尝试 · attempt</span> '
                f'<span class="mono">{_e(attempt.get("run_id"))}</span></span>{_pill(status)}'
                '</div>'
                f'<div class="child-worker">用时：<span class="mono">{_e(attempt.get("duration") or "—")}</span>'
                f' · 更新时间：<span class="mono">{_e(attempt.get("updated_at_display") or attempt.get("updated_at") or "—")}</span></div>'
                f'{_run_stages_html(stages)}'
                '</div>'
            )
        return (
            '<div class="child-runs"><div class="child-runs-title">同一任务的更早尝试 · earlier attempts</div>'
            + "".join(cards)
            + '</div>'
        )

    items = [
        '<div class="recent-head"><span></span><span>运行 run</span><span>状态 status</span>'
        "<span>任务 task</span><span>用时 duration</span><span>更新时间 updated</span></div>"
    ]
    for item in recent:
        current = item.get("current_task") or {}
        run_id = str(item.get("run_id") or "")
        stages = item.get("stages") or []
        done_n = sum(1 for stage in stages if str(stage.get("status")) == "done")
        counter = f'<span class="rs-n">{done_n}/{len(stages)}</span>' if stages else ""
        historical_status = (
            f'<span class="ri-history">历史结果 · {_inline_status(item.get("status"))}</span>'
            if item.get("resolved_by_queue")
            else ""
        )
        display_status = (
            "not_started"
            if item.get("start_condition_unmet")
            else item.get("display_status") or item.get("status")
        )
        recovery_status = (
            _pill(item.get("recovery_status"))
            if item.get("start_condition_unmet") and item.get("recovery_status")
            else ""
        )
        attempts = item.get("attempt_runs") or []
        attempt_badge = f'<span class="attempt-count">共 {len(attempts) + 1} 次尝试</span>' if attempts else ""
        items.append(
            f'<details class="run-item" data-run="{_e(run_id)}">'
            "<summary>"
            '<span class="tw" aria-hidden="true"></span>'
            f'<span class="ri-run mono">{_e(run_id)}</span>'
            f'<span class="ri-status">{_pill(display_status)}{recovery_status}{attempt_badge}{historical_status}</span>'
            f'<span class="ri-task mono">{_e(current.get("id") or "—")}</span>'
            f'<span class="ri-duration mono">{_e(item.get("duration") or "—")}</span>'
            f'<span class="ri-upd mono">{_e(item.get("updated_at_display") or item.get("updated_at"))}</span>'
            "</summary>"
            '<div class="run-stages">'
            f'{start_condition_notice(item)}'
            f'<div class="rs-h">任务环节 · pipeline {counter}</div>'
            f"{_run_stages_html(stages)}"
            f'{_execution_html(item.get("execution") or {}, compact=True)}'
            f'{child_runs_html(item.get("child_runs") or [])}'
            f'{attempt_runs_html(attempts)}'
            "</div>"
            "</details>"
        )
    return '<div class="recent-list">' + "".join(items) + "</div>"


def _tasks_html(tasks: list[dict[str, Any]]) -> str:
    if not tasks:
        return '<div class="empty">暂无任务记录 · no task records</div>'
    cards = []
    for task in tasks:
        verify = task.get("verify") or {}
        review = task.get("review") or {}
        findings = review.get("findings") or []
        resolved_note = ""
        if task.get("resolved_by_queue"):
            resolved_note = (
                '<div class="notice good">已完成·外部收口，无需处理。队列最终状态为 '
                f'{_inline_status(task.get("queue_status"))}；下方校验 / 评审仅保留 Harness 当时的历史结果。</div>'
            )
        elif task.get("queue_status"):
            resolved_note = f'<p class="meta">队列状态 queue_status：{_pill(task.get("queue_status"))}</p>'
        verify_items = []
        for item in verify.get("results") or []:
            label = "PASS" if item.get("ok") else "FAIL"
            verify_items.append(
                f"<li>{_pill(label)} <code>{_e(item.get('command'))}</code> rc={_e(item.get('returncode'))}</li>"
            )
        finding_items = [
            f"<li>{_pill(item.get('priority'))} <span class=\"mono\" style=\"font-size:12px\">{_e(item.get('file'))}:{_e(item.get('line'))}</span> {_e(item.get('title'))}</li>"
            for item in findings
        ]
        cards.append(
            '<article class="task-card">'
            f"<h3>{_e(task.get('task_id') or '-')} {_pill(task.get('display_status') or task.get('status'))}</h3>"
            f"{resolved_note}"
            f"<p>{_e(task.get('message'))}</p>"
            f"<p class=\"meta\">run: {_e(task.get('run_id'))} commit: {_e(task.get('commit')) or '—'}</p>"
            f"<h4>校验 Verify {_pill(verify.get('status') or '-')}</h4>"
            f"<ul>{''.join(verify_items) if verify_items else '<li>暂无校验证据 <small>no verify evidence</small></li>'}</ul>"
            f"<h4>评审 Review {_pill(review.get('status') or '-')}</h4>"
            f"<p>{_e(review.get('message'))}</p>"
            f"<ul>{''.join(finding_items) if finding_items else '<li>暂无评审问题 <small>no findings</small></li>'}</ul>"
            "</article>"
        )
    return "\n".join(cards)


def _actionable_tasks_html(
    tasks: list[dict[str, Any]],
    *,
    detailed: bool = False,
    empty_message: str = "",
) -> str:
    if not tasks:
        message = (
            empty_message
            or "当前没有需要处理的任务；已完成任务只保留在历史记录中。"
        )
        return f'<div class="empty good-empty">{_e(message)}</div>'
    cards = []
    for task in tasks:
        last = (
            f'最近尝试：<span class="mono">{_e(task.get("last_run_id"))}</span> '
            f'{_pill(task.get("last_status"))}'
            if task.get("last_run_id")
            else "尚无 Harness 尝试记录"
        )
        owner = f' · 负责人：<span class="mono">{_e(task.get("owner"))}</span>' if task.get("owner") else ""
        finished = (
            f' · 完成：<span class="mono">{_e(_timestamp_label(task.get("finished_at")))}</span>'
            if task.get("finished_at")
            else ""
        )
        latest_note = (
            f' · 最近备注：{_e(task.get("latest_note"))}'
            if task.get("latest_note")
            else ""
        )
        priority = (
            f'<span class="priority-chip">{_e(task.get("priority"))}</span>'
            if task.get("priority")
            else ""
        )
        dependencies = task.get("dependencies") or []
        dependency_text = "、".join(str(item) for item in dependencies) if dependencies else "无"
        details = (
            f'<div class="action-goal"><span>任务目标</span>{_e(task.get("goal") or "未记录任务目标")}</div>'
            '<div class="action-facts">'
            f'<span>优先级 {priority or "—"}</span>'
            f'<span>依赖 <strong class="mono">{_e(dependency_text)}</strong></span>'
            f'<span>负责人 <strong class="mono">{_e(task.get("owner") or "尚未领取")}</strong></span>'
            '</div>'
            if detailed
            else ""
        )
        cards.append(
            '<article class="action-card">'
            f'<div class="action-head"><strong class="mono">{_e(task.get("task_id"))}</strong>'
            f'<span class="action-head-status">{priority}{_pill(task.get("status"))}</span></div>'
            f'<div class="action-title">{_e(task.get("title") or "未记录任务标题")}</div>'
            f'{details}'
            f'<div class="action-meta">{last}{owner}{finished}{latest_note}</div>'
            f'<div class="action-next"><span>{_e(task.get("action_label") or "建议处理")}</span>{_e(task.get("action"))}</div>'
            '</article>'
        )
    grid_class = "action-grid action-grid-detailed" if detailed else "action-grid"
    return f'<div class="{grid_class}">' + "".join(cards) + '</div>'


def _task_matches_filter(task: dict[str, Any], status_filter: str) -> bool:
    return status_filter == "all" or str(task.get("status") or "") == status_filter


def _task_filter_html(
    tasks: list[dict[str, Any]],
    actionable: list[dict[str, Any]],
    status_filter: str,
) -> str:
    filters = (
        ("all", "需要处理"),
        ("in_progress", "进行中"),
        ("pending", "排队"),
        ("blocked", "阻塞"),
        ("done", "已完成"),
        ("skipped", "已跳过"),
    )
    links = []
    for key, label in filters:
        count = (
            len(actionable)
            if key == "all"
            else sum(1 for task in tasks if _task_matches_filter(task, key))
        )
        active = " is-active" if key == status_filter else ""
        links.append(
            f'<a class="filter-chip{active}" href="{_e(_dashboard_query(view="tasks", status_filter=key))}">'
            f'{_e(label)} <span>{count}</span></a>'
        )
    return '<div class="run-filters">' + "".join(links) + '<span>点击顶部数字可直接进入对应筛选</span></div>'


def _dashboard_query(
    *,
    view: str = "overview",
    run_id: str = "",
    status_filter: str = "",
    detail: str = "",
    page: int = 1,
) -> str:
    params: dict[str, str] = {"view": view}
    if run_id:
        params["run_id"] = run_id
    if status_filter and status_filter != "all":
        params["status"] = status_filter
    if detail and detail != "stages":
        params["detail"] = detail
    if page > 1:
        params["page"] = str(page)
    return "/?" + urlencode(params)


def _dashboard_nav_html(view: str, *, run_count: int, action_count: int) -> str:
    tabs = (
        ("overview", "总览", ""),
        ("runs", "Runs", str(run_count) if run_count else ""),
        ("tasks", "任务队列", str(action_count) if action_count else ""),
        ("events", "事件", ""),
    )
    links = []
    for key, label, count in tabs:
        active = " is-active" if key == view else ""
        current = ' aria-current="page"' if key == view else ""
        badge = f'<span class="nav-count">{_e(count)}</span>' if count else ""
        links.append(
            f'<a class="nav-link{active}" href="{_e(_dashboard_query(view=key))}"{current}>'
            f'{_e(label)}{badge}</a>'
        )
    return '<nav class="dashboard-nav" aria-label="Dashboard 视图">' + "".join(links) + "</nav>"


def _kpi_strip_html(data: dict[str, Any]) -> str:
    queue = data.get("queue") or {}
    counts = queue.get("counts") or {}
    board = data.get("worker_board") or {}
    workers_active = int(board.get("active") or 0)
    concurrency = int(board.get("concurrency") or 0)
    landing = board.get("landing") or []
    action_count = len(data.get("actionable_tasks") or [])
    entries = (
        ("需要处理", "action", action_count, "red" if action_count else "green", _dashboard_query(view="tasks")),
        ("运行中", "workers", f"{workers_active}/{concurrency}", "blue" if workers_active else "slate", _dashboard_query(view="tasks", status_filter="in_progress")),
        ("排队", "pending", int(counts.get("pending") or 0), "amber", _dashboard_query(view="tasks", status_filter="pending")),
        ("阻塞", "blocked", int(counts.get("blocked") or 0), "red", _dashboard_query(view="tasks", status_filter="blocked")),
        ("落地通道", "landing", len(landing), "violet", ""),
        ("已完成", "done", int(counts.get("done") or 0), "slate", _dashboard_query(view="tasks", status_filter="done")),
    )
    cells = []
    for zh, en, value, tone, href in entries:
        tag = "a" if href else "div"
        href_attr = f' href="{_e(href)}" aria-label="查看{_e(zh)}任务"' if href else ""
        link_class = " kpi-link" if href else ""
        cells.append(
            f'<{tag} class="kpi-cell{link_class}"{href_attr}>'
            f'<span class="kpi-label">{_e(zh)} <small>{_e(en)}</small></span>'
            f'<strong class="kpi-value t-{_e(tone)}-text">{_e(value)}</strong>'
            f'</{tag}>'
        )
    capacity = data.get("host_capacity") or {}
    providers = capacity.get("provider_limits") or {}
    occupied = capacity.get("provider_occupied") or {}
    provider_text = " · ".join(
        f"{name} {occupied.get(name, 0)}/{limit}"
        for name, limit in sorted(providers.items())
    )
    secondary = " · ".join(
        part
        for part in (
            f'proposed {int(counts.get("proposed") or 0)}',
            f'skipped {int(counts.get("skipped") or 0)}',
            f'orphan {int(capacity.get("orphan") or 0)}',
            provider_text,
        )
        if part
    )
    return '<section class="kpi-strip">' + "".join(cells) + f'<div class="kpi-secondary">{_e(secondary)}</div></section>'


def _overview_execution_html(data: dict[str, Any]) -> str:
    board = data.get("worker_board") or {}
    workers = board.get("workers") or []
    active = int(board.get("active") or 0)
    concurrency = int(board.get("concurrency") or 0)
    landing = board.get("landing") or []
    active_run_id = str(data.get("active_run_id") or "")
    if not active and not landing:
        enabled_slots = [
            f'W-{int(worker.get("slot") or index + 1):02d}'
            for index, worker in enumerate(workers)
            if bool(worker.get("enabled", True))
        ]
        slots = "".join(f'<span class="idle-slot">{_e(slot)}</span>' for slot in enabled_slots)
        return (
            '<div class="idle-execution">'
            f'<span class="idle-slots">{slots}</span>'
            f'<span>{_e(len(enabled_slots) or concurrency)} 个 Worker 槽位全部空闲，等待下一个就绪任务</span>'
            '<span class="idle-landing">落地通道 <small>landing lane</small> · 空</span>'
            '</div>'
        )
    current = ""
    if active_run_id:
        current = (
            '<div class="current-run-strip"><strong>当前运行</strong>'
            f'<a class="mono" href="{_e(_dashboard_query(view="runs", run_id=active_run_id))}">{_e(active_run_id)}</a>'
            f'<span>活动 {active}/{concurrency}</span></div>'
        )
    return current + _execution_html(board)


def _display_status_for_run(item: dict[str, Any]) -> str:
    if item.get("start_condition_unmet"):
        return "not_started"
    return str(item.get("display_status") or item.get("status") or "unknown")


def _run_has_failed_history(item: dict[str, Any]) -> bool:
    def stages_failed(stages: list[dict[str, Any]]) -> bool:
        return any(str(stage.get("status") or "") == "failed" for stage in stages)

    if stages_failed(item.get("stages") or []):
        return True
    if _status_meta(str(item.get("status") or ""))[2] == "red":
        return True
    if _status_meta(_display_status_for_run(item))[2] == "red":
        return True
    for related in (item.get("attempt_runs") or []) + (item.get("child_runs") or []):
        if (
            stages_failed(related.get("stages") or [])
            or _status_meta(str(related.get("status") or ""))[2] == "red"
            or _status_meta(_display_status_for_run(related))[2] == "red"
        ):
            return True
    return False


def _run_matches_filter(item: dict[str, Any], status_filter: str) -> bool:
    status = _display_status_for_run(item)
    if status_filter == "all":
        return True
    if status_filter == "manual":
        return status == "manual_done"
    if status_filter == "not_started":
        return status == "not_started"
    if status_filter == "failed_history":
        return _run_has_failed_history(item)
    if status_filter == "done":
        return _status_meta(status)[2] == "green" and status != "manual_done"
    return False


def _pipeline_mini_html(stages: list[dict[str, Any]]) -> str:
    dots = []
    failed_labels = []
    done_count = 0
    for stage in stages:
        status = str(stage.get("status") or "pending")
        tone = _STAGE_STATUS_TONE.get(status, "slate")
        label = str(stage.get("label") or stage.get("key") or "阶段")
        if status == "failed":
            failed_labels.append(label)
        if status == "done":
            done_count += 1
        dots.append(
            f'<span class="pipeline-dot t-{_e(tone)}" title="{_e(label)} · {_e(_STAGE_STATUS_ZH.get(status, status))}"></span>'
        )
    if failed_labels:
        summary = "失败：" + "、".join(failed_labels[:2])
    else:
        summary = f"{done_count}/{len(stages)}"
    return '<span class="pipeline-mini">' + "".join(dots) + f'<small>{_e(summary)}</small></span>'


def _runs_table_html(recent: list[dict[str, Any]], *, status_filter: str, limit: int | None = None) -> str:
    filtered = [item for item in recent if _run_matches_filter(item, status_filter)]
    if limit is not None:
        filtered = filtered[:limit]
    if not filtered:
        return '<div class="empty">当前筛选条件下没有 Run</div>'
    rows = []
    for item in filtered:
        current = item.get("current_task") or {}
        run_id = str(item.get("run_id") or "")
        status = _display_status_for_run(item)
        attempts = item.get("attempt_runs") or []
        attempts_html = (
            f'<span class="attempt-count">共 {len(attempts) + 1} 次尝试</span>'
            if attempts
            else ""
        )
        historical = (
            f'<span class="run-history">历史结果 · {_inline_status(item.get("status"))}</span>'
            if item.get("resolved_by_queue")
            else ""
        )
        rows.append(
            f'<a class="run-row" href="{_e(_dashboard_query(view="runs", run_id=run_id))}">'
            f'<span class="run-row-status">{_pill(status)}{attempts_html}</span>'
            f'<span class="run-row-id mono">{_e(run_id)}{historical}</span>'
            '<span class="run-row-task">'
            f'<strong class="mono">{_e(current.get("id") or "—")}</strong>'
            f'<small title="{_e(item.get("task_title") or "")}">{_e(item.get("task_title") or "未记录任务名称")}</small>'
            '</span>'
            f'{_pipeline_mini_html(item.get("stages") or [])}'
            f'<span class="run-row-duration mono">{_e(item.get("duration") or "—")}</span>'
            f'<span class="run-row-updated mono">{_e(item.get("updated_at_display") or item.get("updated_at") or "—")}</span>'
            '</a>'
        )
    return (
        '<div class="runs-table"><div class="runs-head"><span>状态</span><span>运行</span><span>任务</span>'
        '<span>流水线</span><span>用时</span><span>更新</span></div>'
        + "".join(rows)
        + '</div>'
    )


def _run_pagination_html(
    *,
    total: int,
    page: int,
    status_filter: str,
) -> str:
    if total <= RUN_PAGE_SIZE:
        return ""
    page_count = (total + RUN_PAGE_SIZE - 1) // RUN_PAGE_SIZE
    current = min(max(1, page), page_count)
    links: list[str] = []
    if current > 1:
        links.append(
            f'<a class="page-link page-nav" href="{_e(_dashboard_query(view="runs", status_filter=status_filter, page=current - 1))}">← 上一页</a>'
        )
    for number in range(1, page_count + 1):
        active = " is-active" if number == current else ""
        current_attr = ' aria-current="page"' if number == current else ""
        links.append(
            f'<a class="page-link{active}" href="{_e(_dashboard_query(view="runs", status_filter=status_filter, page=number))}"{current_attr}>{number}</a>'
        )
    if current < page_count:
        links.append(
            f'<a class="page-link page-nav" href="{_e(_dashboard_query(view="runs", status_filter=status_filter, page=current + 1))}">下一页 →</a>'
        )
    return (
        '<nav class="pagination" aria-label="Runs 分页">'
        f'<span>第 {current}/{page_count} 页 · 共 {total} 条</span>'
        f'<div>{"".join(links)}</div>'
        '</nav>'
    )


def _run_filter_html(recent: list[dict[str, Any]], status_filter: str) -> str:
    filters = (
        ("all", "全部"),
        ("done", "已完成"),
        ("manual", "外部收口"),
        ("not_started", "未启动"),
        ("failed_history", "有失败历史"),
    )
    links = []
    for key, label in filters:
        count = sum(1 for item in recent if _run_matches_filter(item, key))
        active = " is-active" if key == status_filter else ""
        links.append(
            f'<a class="filter-chip{active}" href="{_e(_dashboard_query(view="runs", status_filter=key))}">'
            f'{_e(label)} <span>{count}</span></a>'
        )
    return '<div class="run-filters">' + "".join(links) + '<span>同一任务的多次尝试合并展示</span></div>'


def _selected_run_list_item(data: dict[str, Any]) -> dict[str, Any]:
    run_id = str(data.get("run_id") or "")
    for item in data.get("recent_runs") or []:
        if str(item.get("run_id") or "") == run_id:
            return item
    run = data.get("run") or {}
    project = (data.get("projects") or [{}])[0]
    repo_root = Path(str(project.get("repo_root") or "."))
    selected_events = list(data.get("events") or [])
    stages = (
        _stage_timeline_from_events(selected_events, run)
        if selected_events and run
        else _run_stage_timeline(
            run_paths(repo_root, run_id).run_dir,
            run,
        )
        if run_id and run
        else []
    )
    return {
        "run_id": run_id,
        "status": run.get("status"),
        "display_status": data.get("run_display_status"),
        "current_task": run.get("current_task") or {},
        "task_title": data.get("current_task_title") or "",
        "stages": stages,
        "attempt_runs": [],
        "child_runs": [],
    }


def _related_runs_html(item: dict[str, Any]) -> str:
    groups = (("历史尝试", item.get("attempt_runs") or []), ("子运行", item.get("child_runs") or []))
    cards = []
    for kind, related_items in groups:
        for related in related_items:
            related_id = str(related.get("run_id") or "")
            task_id = str(related.get("worker_task_id") or (related.get("current_task") or {}).get("id") or "—")
            worker_id = str(related.get("worker_id") or "")
            meta = " · ".join(part for part in (worker_id, task_id, str(related.get("duration") or "")) if part)
            data_attr = "data-attempt-run" if kind == "历史尝试" else "data-child-run"
            cards.append(
                f'<article class="related-card" {data_attr}="{_e(related_id)}">'
                f'<div><span class="related-kind">{_e(kind)}</span> <span class="mono">{_e(related_id)}</span></div>'
                f'<div class="related-meta">{_e(meta)}</div>'
                f'{_run_stages_html(related.get("stages") or [])}'
                '</article>'
            )
    if cards:
        return "".join(cards)
    run_id = str(item.get("run_id") or "")
    stages_url = _dashboard_query(
        view="runs",
        run_id=run_id,
        detail="stages",
    )
    return (
        '<div class="empty">该 Run 没有更早尝试或子运行；'
        f'执行流程请查看 <a href="{_e(stages_url)}">阶段详情</a>。</div>'
    )


def _run_artifacts_html(data: dict[str, Any]) -> str:
    artifacts = []
    summary_path = str(data.get("summary_path") or "")
    if summary_path:
        artifacts.append(summary_path)
    for event in data.get("events") or []:
        artifact = str(event.get("artifact") or "")
        if artifact and artifact not in artifacts:
            artifacts.append(artifact)
    links = "".join(f'<li>{_artifact_link(path)}</li>' for path in artifacts)
    listing = f'<ul class="artifact-list">{links}</ul>' if links else '<div class="empty">暂无产物链接</div>'
    summary = _e(data.get("summary_markdown") or "暂无 summary.md")
    return listing + f'<div class="summary-box">{summary}</div>'


def _run_detail_html(data: dict[str, Any], detail: str) -> str:
    run = data.get("run") or {}
    item = _selected_run_list_item(data)
    run_id = str(data.get("run_id") or "")
    current = run.get("current_task") or {}
    task_title = str(item.get("task_title") or data.get("current_task_title") or "")
    status = _display_status_for_run(item)
    attempts = item.get("attempt_runs") or []
    attempts_html = f'<span class="attempt-count">共 {len(attempts) + 1} 次尝试</span>' if attempts else ""
    limit_help = _limit_explanation(status)
    limit_html = f'<div class="status-help">{_e(limit_help)}</div>' if limit_help else ""
    detail_tabs = (
        ("stages", "阶段详情"),
        ("related", "历史尝试 / 子运行"),
        ("workers", "Worker 映射"),
        ("events", "事件"),
        ("artifacts", "产物"),
    )
    tab_links = []
    for key, label in detail_tabs:
        active = " is-active" if key == detail else ""
        current_attr = ' aria-current="page"' if key == detail else ""
        tab_links.append(
            f'<a class="detail-tab{active}" href="{_e(_dashboard_query(view="runs", run_id=run_id, detail=key))}"{current_attr}>{_e(label)}</a>'
        )
    if detail == "related":
        body = _related_runs_html(item)
    elif detail == "workers":
        body = _execution_html(data.get("execution") or {}, compact=True) or '<div class="empty">没有 Worker 映射记录</div>'
    elif detail == "events":
        body = '<div class="events-wrap">' + _events_html(data.get("events") or []) + '</div>'
    elif detail == "artifacts":
        body = _run_artifacts_html(data)
    else:
        body = (
            '<div class="rs-h">任务环节 · pipeline</div>'
            + _run_stages_html(item.get("stages") or [])
            + '<div class="run-evidence">'
            + _tasks_html(data.get("tasks") or [])
            + '</div>'
        )
    next_action = str(run.get("next_action") or "")
    next_html = f'<div class="run-next"><strong>下一步</strong>{_e(next_action)}</div>' if next_action else ""
    start_notice = ""
    if item.get("start_condition_unmet"):
        successor_run_id = str(item.get("successor_run_id") or "")
        if successor_run_id:
            recovery = _pill(item.get("recovery_status") or "recovered")
            recovery_text = (
                f'队列提交后，已由 <span class="mono">{_e(successor_run_id)}</span> 接续。{recovery}'
            )
        else:
            recovery_text = "请先把队列提交到基线分支，再重新运行。"
        start_notice = (
            '<div class="notice warn">'
            '启动条件未满足：任务尚未进入本次 Git 基线，因此未认领任务、未调用 AI、未消耗重试次数。'
            f'{recovery_text}</div>'
        )
    return (
        f'<a class="back-link" href="{_e(_dashboard_query(view="runs"))}">← 全部 Runs</a>'
        '<section class="card mt12 run-detail">'
        '<div class="run-detail-head">'
        f'<span class="mono run-detail-id">{_e(run_id)}</span>{_pill(status)}{attempts_html}'
        '</div>'
        f'{limit_html}'
        '<div class="run-detail-meta">'
        f'<span>任务 <strong class="mono">{_e(current.get("id") or "—")}</strong></span>'
        f'<span>名称 <strong>{_e(task_title or "未记录任务名称")}</strong></span>'
        f'<span>用时 <strong class="mono">{_e(data.get("run_duration") or "—")}</strong></span>'
        f'<span>更新 <strong class="mono">{_e(_timestamp_label(run.get("updated_at")) or "—")}</strong></span>'
        f'{_pipeline_mini_html(item.get("stages") or [])}'
        '</div>'
        f'{start_notice}{next_html}<div class="detail-tabs">{"".join(tab_links)}</div>'
        f'<div class="detail-body">{body}</div>'
        '</section>'
    )


_DASHBOARD_CSS = """
:root {
  --accent:#4f46e5; --bg:#f4f5f7; --ink:#20242c; --head:#12151b;
  --muted:#8b93a1; --muted2:#9aa1ad; --mono-ink:#586074; --text:#3a3f4a;
  --line:#e6e8ec; --line-soft:#f1f3f6; --line-head:#eceef2; --zebra:#f9fafb;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif; }
.mono, code { font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
code { font-size:12px; color:var(--mono-ink); }
a { color:var(--accent); text-decoration:none; overflow-wrap:anywhere; }
a:hover { color:#3730a3; text-decoration:underline; }
.shell { max-width:1440px; margin:0 auto; padding:40px 40px 64px; }
@keyframes acedot { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.3;transform:scale(.65)} }
.livedot { display:inline-block; width:8px; height:8px; border-radius:999px; background:#22b06e; box-shadow:0 0 0 3px rgba(34,176,110,.15); animation:acedot 1.8s ease-in-out infinite; }
header { display:flex; justify-content:space-between; align-items:flex-start; gap:28px; flex-wrap:wrap; }
.header-live { display:flex; align-items:center; justify-content:flex-end; gap:16px; flex-wrap:wrap; color:var(--muted); font-size:12px; }
.header-live > span { display:inline-flex; align-items:center; gap:7px; }
.header-live .dim { color:var(--muted2); }
h1 { margin:0; font-size:30px; font-weight:700; letter-spacing:-.02em; color:var(--head); }
h1 .accent { color:var(--accent); }
.title-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.badge { display:inline-flex; align-items:center; gap:6px; padding:4px 11px; border-radius:999px; font-size:12px; font-weight:600; background:#eef1f5; color:#586074; border:1px solid #dde2ea; white-space:nowrap; }
.badge .en { font-size:10.5px; opacity:.7; font-family:'IBM Plex Mono',monospace; }
.meta-rows { display:flex; flex-direction:column; gap:7px; margin-top:16px; font-size:14px; }
.meta-rows > div { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.meta-rows .k { color:var(--muted); margin-right:2px; }
.meta-rows .v { color:var(--text); }
.meta-rows .m { font-family:'IBM Plex Mono',monospace; color:var(--mono-ink); word-break:break-all; }
.meta-rows .dim { color:var(--muted2); }
.status-side { display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
.status-side .lbl { font-size:12px; color:var(--muted2); font-weight:500; }
.card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:22px; box-shadow:0 1px 2px rgba(16,24,40,.04); overflow:hidden; }
.section-title-row { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.section-title-row > a { padding-top:2px; font-size:12.5px; font-weight:600; white-space:nowrap; }
.sec-h { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
.sec-h .bar { width:4px; height:18px; border-radius:2px; background:var(--accent); flex:none; }
.sec-h h2 { margin:0; font-size:16px; font-weight:700; color:var(--head); }
.sec-h .en { color:var(--muted2); font-weight:500; font-size:13px; font-family:'IBM Plex Mono',monospace; }
.grid-top { display:grid; grid-template-columns:1.55fr 1.12fr 1fr; gap:20px; margin-top:28px; align-items:start; }
.grid-two { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-top:20px; align-items:start; }
.mt20 { margin-top:20px; }
.mt12 { margin-top:12px; }
.project-chip { display:inline-flex; align-items:center; gap:9px; padding:6px 12px; border-radius:9px; border:1px solid var(--line); background:#fff; box-shadow:0 1px 2px rgba(16,24,40,.04); }
.project-chip strong { font-size:13px; }
.project-chip .mono { color:var(--muted2); font-size:11px; }
.kpi-strip { display:flex; align-items:stretch; flex-wrap:wrap; gap:0; margin-top:16px; padding:13px 20px; background:#fff; border:1px solid var(--line); border-radius:14px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
.kpi-cell { display:flex; flex-direction:column; gap:5px; min-width:94px; padding-right:24px; margin-right:24px; border-right:1px solid var(--line-soft); }
.kpi-link { color:inherit; border-radius:8px; }
.kpi-link:hover { color:inherit; text-decoration:none; background:#f8f9fb; box-shadow:0 0 0 7px #f8f9fb; }
.kpi-link:focus-visible { outline:2px solid var(--accent); outline-offset:5px; }
.kpi-label { color:var(--muted); font-size:12px; white-space:nowrap; }
.kpi-label small { color:var(--muted2); font-family:'IBM Plex Mono',monospace; font-size:10px; }
.kpi-value { color:var(--head); font-family:'IBM Plex Mono',monospace; font-size:21px; line-height:1; }
.t-green-text { color:#157347; } .t-blue-text { color:#1d4ed8; } .t-red-text { color:#c0342e; } .t-amber-text { color:#b45309; } .t-violet-text { color:#6d28d9; } .t-slate-text { color:#586074; }
.kpi-secondary { align-self:center; margin-left:auto; color:var(--muted2); font-family:'IBM Plex Mono',monospace; font-size:10.5px; line-height:1.7; text-align:right; }
.dashboard-nav { display:flex; gap:2px; margin-top:18px; border-bottom:1px solid #e2e5ea; overflow-x:auto; }
.nav-link, .detail-tab { display:inline-flex; align-items:center; gap:7px; padding:9px 14px 11px; color:#586074; font-size:13.5px; font-weight:500; white-space:nowrap; border-bottom:2px solid transparent; }
.nav-link:hover, .detail-tab:hover { color:#3730a3; text-decoration:none; }
.nav-link.is-active, .detail-tab.is-active { color:var(--accent); font-weight:700; border-bottom-color:var(--accent); }
.nav-count { padding:0 7px; border-radius:999px; background:#f1f3f6; color:var(--muted); font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:600; }
.nav-link.is-active .nav-count { background:#eef0fe; color:var(--accent); }
.idle-execution { display:flex; align-items:center; gap:16px; flex-wrap:wrap; padding:13px 16px; border:1px dashed #dfe3e9; border-radius:10px; background:#fbfcfd; color:#586074; font-size:13px; }
.idle-slots { display:flex; gap:6px; flex-wrap:wrap; }
.idle-slot { padding:3px 9px; border:1px dashed #d6dae1; border-radius:7px; background:#fff; color:var(--muted2); font-family:'IBM Plex Mono',monospace; font-size:10.5px; }
.idle-landing { margin-left:auto; color:var(--muted2); font-size:12px; }
.idle-landing small { font-family:'IBM Plex Mono',monospace; }
.current-run-strip { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px; padding:11px 14px; border:1px solid #c9dcfb; border-radius:10px; background:#f4f8ff; font-size:12px; }
.current-run-strip strong { color:#1d4ed8; }
.current-run-strip span { margin-left:auto; color:#586074; }
.run-filters { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
.run-filters > span { margin-left:auto; color:var(--muted2); font-size:12px; }
.filter-chip { display:inline-flex; align-items:center; gap:6px; padding:5px 13px; border:1px solid var(--line); border-radius:999px; color:#586074; background:#fff; font-size:12.5px; font-weight:600; }
.filter-chip:hover { color:#3730a3; text-decoration:none; border-color:#c7ccf5; }
.filter-chip.is-active { color:var(--accent); border-color:#c7ccf5; background:#eef0fe; }
.filter-chip span { font-family:'IBM Plex Mono',monospace; font-size:11px; opacity:.75; }
.runs-table { display:flex; flex-direction:column; overflow-x:auto; }
.runs-head, .run-row { display:grid; grid-template-columns:260px minmax(220px,1fr) 200px 180px 120px 148px; gap:14px; align-items:center; min-width:1200px; }
.runs-head { padding:8px 12px; color:var(--muted); font-size:11.5px; font-weight:600; border-bottom:1px solid var(--line-head); }
.run-row { padding:11px 12px; color:var(--text); border-bottom:1px solid #f4f5f8; }
.run-row:hover { background:#f9fafb; color:var(--text); text-decoration:none; }
.run-row-status { display:flex; flex-direction:column; align-items:flex-start; gap:4px; min-width:0; }
.run-row-id { min-width:0; color:var(--ink); font-size:12.5px; word-break:break-all; }
.run-history { display:block; margin-top:2px; color:var(--muted2); font-size:10.5px; }
.run-row-task { display:flex; min-width:0; flex-direction:column; gap:3px; font-size:12.5px; font-weight:600; }
.run-row-task small { overflow:hidden; color:var(--muted); font-size:10.5px; font-weight:500; line-height:1.35; text-overflow:ellipsis; white-space:nowrap; }
.run-row-duration, .run-row-updated { color:#586074; font-size:11.5px; }
.pipeline-mini { display:flex; align-items:center; gap:3px; min-width:0; }
.pipeline-mini small { margin-left:6px; color:var(--muted2); font-family:'IBM Plex Mono',monospace; font-size:10.5px; white-space:nowrap; }
.pipeline-dot { width:8px; height:8px; flex:none; border:1px solid transparent; border-radius:999px; }
.pipeline-dot.t-green { background:#22b06e; } .pipeline-dot.t-blue { background:#3b82f6; } .pipeline-dot.t-red { background:#e5484d; } .pipeline-dot.t-amber { background:#f0a020; } .pipeline-dot.t-violet { background:#8b5cf6; } .pipeline-dot.t-slate { background:#fff; border-color:#d0d5dd; }
.pagination { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:18px; color:var(--muted); font-size:12px; }
.pagination > div { display:flex; align-items:center; justify-content:flex-end; gap:6px; flex-wrap:wrap; }
.page-link { display:inline-flex; min-width:30px; height:30px; align-items:center; justify-content:center; padding:0 9px; border:1px solid var(--line); border-radius:8px; background:#fff; color:#586074; font-family:'IBM Plex Mono',monospace; font-size:11.5px; }
.page-link:hover { border-color:#c7ccf5; color:#3730a3; text-decoration:none; }
.page-link.is-active { border-color:#c7ccf5; background:#eef0fe; color:var(--accent); font-weight:700; }
.page-link.page-nav { font-family:inherit; white-space:nowrap; }
.back-link { display:inline-flex; padding:3px 0; font-size:13px; font-weight:600; }
.run-detail-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.run-detail-id { color:var(--head); font-size:16px; font-weight:700; word-break:break-all; }
.run-detail-meta { display:flex; align-items:center; gap:8px 22px; flex-wrap:wrap; margin-top:12px; color:#586074; font-size:12.5px; }
.run-detail-meta .pipeline-mini { margin-left:auto; }
.run-next { display:flex; gap:10px; margin-top:14px; padding:10px 12px; border:1px solid #f4e1ba; border-radius:9px; background:#fffaf1; color:#586074; font-size:12.5px; line-height:1.5; }
.run-next strong { flex:none; color:#b45309; }
.detail-tabs { display:flex; gap:2px; margin-top:18px; border-bottom:1px solid var(--line-head); overflow-x:auto; }
.detail-body { padding-top:14px; }
.run-evidence { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:12px; margin-top:18px; }
.run-evidence .task-card + .task-card { margin-top:0; }
.related-card { padding:12px 14px; border:1px solid var(--line-soft); border-radius:10px; background:#fafbfc; }
.related-card + .related-card { margin-top:10px; }
.related-kind { display:inline-flex; margin-right:8px; padding:2px 8px; border-radius:999px; background:#eef1f5; color:#586074; font-size:10.5px; font-weight:700; }
.related-meta { margin:8px 0 10px; color:var(--muted); font-size:11.5px; }
.artifact-list { margin:0 0 14px; padding-left:20px; }
.artifact-list li { margin:6px 0; font-family:'IBM Plex Mono',monospace; font-size:12px; }
@media (max-width:1180px) { .grid-top{grid-template-columns:1fr} .grid-two{grid-template-columns:1fr} }
.scroll-x { overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th { padding:0 12px 10px; font-size:12px; font-weight:600; color:var(--muted); text-align:left; border-bottom:1px solid var(--line-head); white-space:nowrap; }
td { padding:12px; font-size:13px; color:var(--text); border-bottom:1px solid var(--line-soft); vertical-align:top; }
tbody tr:nth-child(even) { background:var(--zebra); }
th.num, td.num { text-align:right; }
td.num { font-family:'IBM Plex Mono',monospace; font-size:14px; }
.cell-main { font-size:14px; font-weight:600; color:var(--ink); }
.cell-sub { font-size:12px; color:var(--muted2); font-family:'IBM Plex Mono',monospace; margin-top:2px; }
.pill { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:999px; font-size:12.5px; font-weight:600; white-space:nowrap; border:1px solid transparent; }
.pill .en { font-size:10.5px; font-weight:500; opacity:.72; font-family:'IBM Plex Mono',monospace; }
.pill-lg { font-size:15px; padding:6px 14px; gap:7px; }
.pill-lg .en { font-size:12px; }
.pill-lg .dot { width:8px; height:8px; border-radius:999px; background:currentColor; animation:acedot 1.8s ease-in-out infinite; }
.status-zh { margin-left:3px; color:var(--muted); font-size:11px; font-family:'IBM Plex Sans',sans-serif; }
.status-help { margin-top:7px; color:#6b7280; font-size:12px; line-height:1.55; }
.t-green { background:#e7f5ee; color:#157347; border-color:#c3e6d2; }
.t-blue { background:#e8f0fe; color:#1d4ed8; border-color:#c9dcfb; }
.t-violet { background:#efeafd; color:#6d28d9; border-color:#ddd0fb; }
.t-amber { background:#fdf4e3; color:#b45309; border-color:#f4e1ba; }
.t-red { background:#fdeceb; color:#c0342e; border-color:#f6d2d0; }
.t-slate { background:#eef1f5; color:#586074; border-color:#dde2ea; }
.chip { display:inline-flex; align-items:center; gap:5px; padding:2px 8px; border-radius:6px; font-size:12px; background:#f1f3f6; color:#586074; white-space:nowrap; }
.chip .en { font-size:10.5px; opacity:.68; font-family:'IBM Plex Mono',monospace; }
.tiles { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
.tile { border:1px solid var(--line-head); border-radius:10px; padding:13px 12px; background:#fbfcfd; }
.tile .n { font-size:24px; font-weight:700; color:var(--head); font-family:'IBM Plex Mono',monospace; line-height:1; }
.tile .lab { display:flex; align-items:center; gap:6px; margin-top:9px; }
.tile .dot { width:7px; height:7px; border-radius:999px; flex:none; }
.tile .zh { font-size:12.5px; font-weight:600; color:var(--text); }
.tile .en { font-size:10.5px; color:var(--muted2); font-family:'IBM Plex Mono',monospace; margin-top:2px; margin-left:13px; }
.kv-foot { margin-top:16px; padding-top:14px; border-top:1px solid var(--line-soft); display:flex; flex-wrap:wrap; gap:8px 20px; font-size:12.5px; }
.kv-foot .k { color:var(--muted); }
.kv-foot .m { font-family:'IBM Plex Mono',monospace; color:var(--text); }
.field { margin-bottom:14px; }
.field .k { font-size:11.5px; color:var(--muted); margin-bottom:5px; }
.field .m { font-family:'IBM Plex Mono',monospace; font-size:13px; color:var(--ink); word-break:break-all; line-height:1.5; }
.field .sub { font-size:11.5px; color:var(--muted2); margin-top:8px; line-height:1.6; overflow-wrap:anywhere; }
.run-stats { padding-top:12px; border-top:1px solid var(--line-soft); display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:12px; }
.run-stats .k { color:var(--muted); }
.run-stats .m { font-family:'IBM Plex Mono',monospace; color:var(--text); }
.execution-board { margin-top:20px; padding:18px; border:1px solid #e0e3f7; border-radius:12px; background:#fafaff; }
.execution-meta { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px; color:var(--muted); font-size:12px; }
.execution-meta strong { color:var(--head); font-size:14px; }
.execution-meta .mono { margin-left:auto; color:var(--accent); font-weight:600; }
.worker-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(245px,1fr)); gap:12px; }
.worker-card { min-width:0; padding:14px; border:1px solid var(--line); border-radius:10px; background:#fff; }
.worker-card.worker-idle { border-style:dashed; background:#fbfbfc; }
.worker-card.worker-disabled { border-style:dashed; background:#f2f3f5; opacity:.78; }
.worker-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.worker-name { color:var(--muted); font-size:11px; font-weight:600; text-transform:uppercase; }
.worker-task { margin-top:13px; color:var(--head); font-family:'IBM Plex Mono',monospace; font-size:18px; font-weight:700; }
.worker-title { min-height:34px; margin-top:4px; color:var(--text); font-size:12.5px; line-height:1.45; }
.worker-meta { margin-top:8px; color:var(--muted); font-size:11px; overflow-wrap:anywhere; }
.landing-lane { display:flex; align-items:flex-start; gap:14px; margin-top:12px; padding:12px 14px; border:1px solid #dbeade; border-radius:10px; background:#f7fcf8; }
.landing-label { flex:none; color:#28764d; font-size:12px; font-weight:700; }
.landing-label small { display:block; color:#6c927b; font-family:'IBM Plex Mono',monospace; font-weight:500; }
.landing-items { display:flex; flex-wrap:wrap; gap:8px; }
.landing-item { display:inline-flex; align-items:center; gap:6px; padding:4px 7px; border:1px solid #dce6de; border-radius:7px; background:#fff; font-size:11px; }
.landing-empty { color:var(--muted); font-size:12px; }
.attempt-count { display:inline-flex; color:#586074; background:#eef1f5; border-radius:999px; padding:2px 7px; font-size:10.5px; white-space:nowrap; }
.action-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.action-grid-detailed { grid-template-columns:1fr; }
.action-card { border:1px solid #f0d7a8; background:#fffaf1; border-radius:11px; padding:15px; }
.action-head { display:flex; justify-content:space-between; align-items:center; gap:10px; }
.action-head-status { display:flex; align-items:center; justify-content:flex-end; gap:7px; flex-wrap:wrap; }
.priority-chip { display:inline-flex; align-items:center; min-height:24px; padding:1px 8px; border:1px solid #ddd6fe; border-radius:999px; background:#f5f3ff; color:#6d28d9; font:700 12px/1.2 var(--mono); }
.action-title { margin-top:9px; font-size:13.5px; font-weight:600; color:var(--ink); }
.action-goal { margin-top:8px; color:var(--text); font-size:12.5px; line-height:1.6; }
.action-goal > span { margin-right:9px; color:#b45309; font-size:11.5px; font-weight:700; }
.action-facts { display:flex; flex-wrap:wrap; gap:7px 20px; margin-top:9px; color:var(--muted); font-size:11.5px; }
.action-facts > span { display:inline-flex; align-items:center; gap:6px; }
.action-meta { margin-top:9px; color:var(--muted); font-size:11.5px; line-height:1.55; }
.action-next { margin-top:11px; padding-top:10px; border-top:1px solid #f3e3c5; font-size:12.5px; line-height:1.6; color:var(--text); }
.action-next span { color:#b45309; font-weight:700; margin-right:8px; }
.good-empty { color:#157347; border-color:#c3e6d2; background:#f3fbf7; }
.execution-compact { margin-top:14px; padding:12px; }
.execution-compact .worker-card { padding:11px; }
.empty { border:1px dashed #dfe3e9; border-radius:10px; padding:30px; text-align:center; color:var(--muted2); font-size:13px; background:#fbfcfd; }
.notice { border:1px dashed #dfe3e9; border-radius:10px; padding:10px 12px; color:var(--muted); font-size:12.5px; background:#fbfcfd; margin-bottom:12px; line-height:1.6; }
.notice.good { color:#157347; border-color:#c3e6d2; background:#e7f5ee; }
.notice.warn { color:#92400e; border-color:#f4e1ba; background:#fdf4e3; }
.notice.bad { color:#c0342e; border-color:#f6d2d0; background:#fdeceb; }
.task-card { border:1px solid var(--line-head); border-radius:10px; padding:14px; background:#fbfcfd; }
.task-card + .task-card { margin-top:12px; }
.task-card h3 { margin:0 0 8px; font-size:14.5px; font-weight:600; color:var(--ink); display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-family:'IBM Plex Mono',monospace; }
.task-card h4 { margin:12px 0 6px; font-size:12px; color:var(--muted); display:flex; align-items:center; gap:8px; }
.task-card p { margin:0 0 6px; font-size:13px; color:var(--text); }
.task-card .meta { font-size:12px; color:var(--muted2); font-family:'IBM Plex Mono',monospace; word-break:break-all; }
.task-card ul { margin:0; padding-left:18px; }
.task-card li { margin:4px 0; font-size:12.5px; color:var(--text); }
.kv-line { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
.kv-line .k { font-size:13px; color:var(--muted); min-width:96px; }
.kv-line .m { font-family:'IBM Plex Mono',monospace; font-size:14px; color:var(--text); }
.events-wrap { max-height:560px; overflow:auto; }
.summary-box { white-space:pre-wrap; max-height:420px; overflow:auto; background:#fbfcfd; border:1px solid var(--line-head); border-radius:10px; padding:14px; font-size:12.5px; font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace; color:var(--text); line-height:1.6; }
.section-hint { display:block; font-size:12px; color:var(--muted2); margin:-6px 0 14px; }
.recent-list { display:flex; flex-direction:column; }
.recent-head, .run-item > summary { display:grid; grid-template-columns:22px minmax(0,2.4fr) 1fr .8fr .85fr 1.1fr; gap:12px; align-items:center; }
.recent-head { padding:0 12px 10px; font-size:12px; font-weight:600; color:var(--muted); border-bottom:1px solid var(--line-head); }
.run-item { border-bottom:1px solid var(--line-soft); }
.run-item > summary { list-style:none; cursor:pointer; padding:12px; }
.run-item > summary::-webkit-details-marker { display:none; }
.run-item > summary:hover { background:var(--zebra); }
.run-item > summary:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; border-radius:8px; }
.tw { width:20px; height:20px; border:1px solid var(--line); border-radius:6px; display:inline-flex; align-items:center; justify-content:center; color:var(--muted); font-family:'IBM Plex Mono',monospace; font-size:15px; font-weight:600; line-height:1; }
.tw::before { content:"+"; }
.run-item[open] > summary .tw::before { content:"−"; }
.run-item[open] > summary .tw { color:var(--accent); border-color:#c7ccf5; background:#eef0fe; }
.ri-run { font-size:13px; color:var(--ink); word-break:break-all; }
.ri-status { display:flex; flex-direction:column; align-items:flex-start; gap:4px; }
.ri-history { font-size:10.5px; color:var(--muted2); font-family:'IBM Plex Mono',monospace; }
.ri-task { font-size:13px; }
.ri-duration { font-size:12px; color:#3a3f4a; white-space:nowrap; }
.ri-upd { font-size:12px; color:#586074; }
.run-stages { padding:2px 12px 18px 44px; }
.child-runs { margin-top:16px; padding-top:14px; border-top:1px solid var(--line-soft); }
.child-runs-title { color:var(--muted); font-size:12px; font-weight:600; margin-bottom:10px; }
.child-run { padding:12px; border:1px solid var(--line-soft); border-radius:10px; background:#fafbfc; }
.child-run + .child-run { margin-top:10px; }
.child-run-head { display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:10px; color:var(--text); font-size:12.5px; }
.child-worker { margin:-3px 0 10px; color:var(--muted); font-size:11.5px; }
.rs-h { font-size:12px; color:var(--muted); margin-bottom:10px; display:flex; align-items:center; gap:8px; }
.rs-n { font-family:'IBM Plex Mono',monospace; color:var(--text); background:#f1f3f6; border-radius:6px; padding:1px 7px; font-size:11.5px; }
.stepper { display:flex; flex-wrap:wrap; gap:8px; }
.step { display:inline-flex; align-items:center; gap:7px; padding:6px 11px; border-radius:8px; border:1px solid var(--line-head); background:#fbfcfd; }
.step .sdot { width:8px; height:8px; border-radius:999px; background:currentColor; flex:none; }
.step .slabel { display:flex; flex-direction:column; line-height:1.25; color:var(--text); font-weight:600; font-size:12px; }
.step .slabel .en { font-size:10px; font-weight:500; opacity:.6; font-family:'IBM Plex Mono',monospace; }
.step .smodel { align-self:flex-start; margin-top:4px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:600; font-family:'IBM Plex Mono',monospace; color:#6d28d9; background:#efeafd; border:1px solid #ddd0fb; border-radius:5px; padding:1px 6px; }
.step .ssession { align-self:flex-start; margin-top:3px; max-width:210px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:600; color:#1d4ed8; background:#eaf2ff; border:1px solid #c9dcff; border-radius:5px; padding:1px 6px; }
.step .ssession .en { margin-left:5px; color:#6d7d99; font-size:9px; }
.step.step-agent { border-color:#ddd0fb; }
.step.step-pending .smodel { color:#8478c4; opacity:.9; }
.step .sstate { font-size:10.5px; font-weight:600; padding:1px 6px; border-radius:999px; background:rgba(16,24,40,.05); }
.step.t-green { color:#157347; } .step.t-green .sstate { background:#e7f5ee; color:#157347; }
.step.t-blue { color:#1d4ed8; } .step.t-blue .sstate { background:#e8f0fe; color:#1d4ed8; }
.step.t-red { color:#c0342e; border-color:#f6d2d0; background:#fdeceb; } .step.t-red .sstate { background:#fff; color:#c0342e; }
.step.step-pending { border-style:dashed; background:#fbfcfd; } .step.step-pending .slabel { color:var(--muted2); font-weight:500; } .step.step-pending .sstate { background:#f1f3f6; color:#9aa1ad; }
.step.step-running .sdot { animation:acedot 1.4s ease-in-out infinite; }
.stage-empty { font-size:12px; color:var(--muted2); }
@media (max-width:720px) {
  .shell { padding:22px 16px 44px; }
  h1 { font-size:24px; }
  .status-side { align-items:flex-start; }
  .kpi-strip { padding:12px 14px; }
  .kpi-cell { min-width:82px; padding-right:13px; margin-right:13px; margin-bottom:10px; }
  .kpi-secondary { width:100%; margin:0; text-align:left; }
  .idle-landing { width:100%; margin-left:0; }
  .runs-head { display:none; }
  .run-row { grid-template-columns:1fr auto; gap:7px 12px; min-width:0; }
  .run-row-status, .run-row-id, .pipeline-mini { grid-column:1 / -1; }
  .run-row-task, .run-row-duration, .run-row-updated { font-size:11.5px; }
  .run-row-updated { grid-column:1 / -1; }
  .pagination { align-items:flex-start; flex-direction:column; }
  .pagination > div { justify-content:flex-start; }
  .run-detail-meta .pipeline-mini { width:100%; margin-left:0; }
  .action-grid { grid-template-columns:1fr; }
  .recent-head { display:none; }
  .run-item > summary { grid-template-columns:22px 1fr; row-gap:6px; }
  .ri-status, .ri-task, .ri-duration, .ri-upd { grid-column:2; }
  .run-stages { padding-left:12px; }
}
"""


# 只读、纯展示脚本：把「最近 Runs」里展开的 run 记到 sessionStorage，
# 让每 5 秒的 <meta refresh> 自动刷新后仍保持展开态。不发请求、不改服务端状态。
_RECENT_RUNS_SCRIPT = """<script>
(function () {
  try {
    var KEY = "autodev.recent.open";
    var open = new Set(JSON.parse(sessionStorage.getItem(KEY) || "[]"));
    var items = document.querySelectorAll("details.run-item");
    items.forEach(function (node) {
      var id = node.getAttribute("data-run") || "";
      if (open.has(id)) { node.open = true; }
      node.addEventListener("toggle", function () {
        if (node.open) { open.add(id); } else { open.delete(id); }
        try { sessionStorage.setItem(KEY, JSON.stringify(Array.from(open))); } catch (e) {}
      });
    });
  } catch (e) {}
})();
</script>"""


def _sec_h(zh: str, en: str = "") -> str:
    en_html = f' <span class="en">{_e(en)}</span>' if en else ""
    return f'<div class="sec-h"><span class="bar"></span><h2>{zh}{en_html}</h2></div>'


def _render_dashboard_html_legacy(data: dict[str, Any], *, refresh_seconds: int = 0) -> str:
    projects = data.get("projects") or [{}]
    project = projects[0]
    queue = data.get("queue") or {}
    current_run_visible = bool(data.get("current_run_visible"))
    selected_run = data.get("run") or {}
    run = selected_run if current_run_visible else {}
    summary = run.get("summary") or {}
    findings = summary.get("findings") or {}
    blocking = data.get("blocking") or {}
    run_kind = str(data.get("run_kind") or "none")
    if run_kind == "active":
        run_title, run_en, run_notice = "活动 Run", "active", ""
    elif run_kind == "selected":
        run_title, run_en, run_notice = "指定 Run", "selected", ""
    elif run_kind == "stale":
        run_title, run_en = "中断残留 Run（无进程）", "stale"
        run_notice = '<div class="notice">run 文件仍是运行态，但本机没有 AutoDev controller 进程；通常是手动中断后的残留状态。</div>'
    elif run_kind == "latest":
        run_title, run_en = "当前运行（无活动）", "current"
        run_notice = '<div class="notice">当前没有运行中的 Harness。最近一次结果只在下方“最近 Runs”中展示，不代表仍需处理。</div>'
    else:
        run_title, run_en = "当前运行（无活动）", "current"
        run_notice = '<div class="notice">当前没有运行中的 Harness，也没有历史 run 记录。</div>'
    recent_runs_html = _recent_runs_html(data.get("recent_runs") or [])
    proposed = queue.get("proposed") or []
    proposed_text = ", ".join(str(item.get("id")) for item in proposed) if proposed else "none"
    queue_error_notice = (
        f'<div class="notice bad">队列读取失败 · queue unavailable: {_e(queue.get("error"))}</div>'
        if queue.get("error")
        else ""
    )
    refresh_meta = f'<meta http-equiv="refresh" content="{refresh_seconds}">\n' if refresh_seconds > 0 else ""
    refreshed_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    live_text = f"· 每 {refresh_seconds} 秒自动刷新" if refresh_seconds > 0 else ""
    livedot = '<span class="livedot"></span>' if refresh_seconds > 0 else ""
    current_task = (data.get("current_task") or {}) if current_run_visible else {}
    run_resolved_by_queue = bool(data.get("run_resolved_by_queue")) if current_run_visible else False
    run_history = (
        f'<div class="sub">历史 Run 结果：{_inline_status(run.get("status") or "-")}</div>'
        if run_resolved_by_queue
        else ""
    )
    task_history = (
        f'<div class="sub">历史阶段状态：{_inline_status(current_task.get("status") or "-")}</div>'
        if run_resolved_by_queue
        else ""
    )
    run_stats_history = (
        '<div class="sub" style="margin-bottom:8px">以下为该次 Run 的历史统计。</div>'
        if run_resolved_by_queue
        else ""
    )
    capacity_html = _capacity_html(data.get("host_capacity") or {})
    execution_html = _execution_html(data.get("worker_board") or {})
    execution_section = f'<section class="card mt20">{_sec_h("Worker 槽位 / 任务映射", "worker assignment")}{execution_html}</section>'
    run_status_for_help = (data.get("run_display_status") or run.get("status") or "-") if current_run_visible else "no_run"
    run_status_help = _limit_explanation(run_status_for_help)
    blocking_status_help = _limit_explanation(blocking.get("status"))
    run_id_text = data.get("run_id") if current_run_visible else "—"
    run_status_text = (data.get("run_display_status") or run.get("status") or "-") if current_run_visible else "no_run"
    task_status_text = (data.get("current_task_display_status") or current_task.get("status") or "-") if current_run_visible else "no_run"
    run_duration_text = (data.get("run_duration") or "—") if current_run_visible else "—"
    html_text = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
{refresh_meta}<meta http-equiv="Cache-Control" content="no-store">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoDev 只读状态页</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>{_DASHBOARD_CSS}</style>
</head>
<body>
<div class="shell">
  <header>
    <div style="min-width:0">
      <div class="title-row">
        <h1>AutoDev <span class="accent">Harness</span></h1>
        <span class="badge">只读 <span class="en">read-only</span></span>
      </div>
      <div class="meta-rows">
        <div><span class="k">项目</span><span class="v">{_e(project.get("name"))}</span> <span class="dim">·</span> <span class="m">{_e(project.get("id"))}</span></div>
        <div><span class="k">仓库</span><span class="m">{_e(project.get("repo_root"))}</span></div>
        <div><span class="k">刷新时间</span>{livedot}<span class="m">{_e(refreshed_at)}</span><span class="dim">{_e(live_text)}</span></div>
      </div>
    </div>
    <div class="status-side">
      <span class="lbl">Harness 状态 · harness status</span>
      {_pill(blocking.get("status") or "no_run", large=True)}
    </div>
  </header>

  <section class="grid-top">
    <div class="card">
      {_sec_h("项目列表", "projects")}
      {capacity_html}
      {_projects_html(projects)}
    </div>
    <div class="card">
      {_sec_h("队列统计", "queue")}
      {queue_error_notice}
      <div class="tiles">{_counts_html(queue.get("counts") or {})}</div>
      <div class="kv-foot">
        <span><span class="k">下一个 next</span> <span class="m">{_e(queue.get("next") or "—")}</span></span>
        <span><span class="k">已提议 proposed</span> <span class="m">{_e(proposed_text)}</span></span>
      </div>
    </div>
    <div class="card">
      {_sec_h(_e(run_title), run_en)}
      {run_notice}
      <div class="field">
        <div class="k">运行 ID · run_id</div>
        <div class="m">{_e(run_id_text)}</div>
      </div>
      <div class="field">
        <div class="k">运行状态 · run_status</div>
        {_pill(run_status_text)}
        {run_status_help}
        {run_history}
        <div class="sub">活动 active: <span class="mono">{_e(data.get("active_run_id") or "—")}</span> · 陈旧 stale: <span class="mono">{_e(data.get("stale_run_id") or "—")}</span></div>
      </div>
      <div class="field">
        <div class="k">当前任务 · current_task</div>
        <span class="mono" style="font-size:14px;font-weight:600">{_e(current_task.get("id") or "—")}</span> {_pill(task_status_text)}
        {task_history}
      </div>
      <div class="field">
        <div class="k">本次 Run 用时 · duration</div>
        <div class="m">{_e(run_duration_text)}</div>
      </div>
      {run_stats_history}<div class="run-stats">
        <span><span class="k">完成 done</span>= <span class="m">{_e(summary.get("tasks_done", 0))}</span></span>
        <span><span class="k">阻塞 blocked</span>= <span class="m">{_e(summary.get("tasks_blocked", 0))}</span></span>
        <span><span class="k">P0</span>= <span class="m">{_e(findings.get("p0", 0))}</span></span>
        <span><span class="k">P1</span>= <span class="m">{_e(findings.get("p1", 0))}</span></span>
      </div>
    </div>
  </section>

  {execution_section}

  <section class="card mt20">
    {_sec_h("需要处理的任务", "action required")}
    <span class="section-hint">只显示队列中仍为 pending / in_progress / blocked 的任务；done / skipped 无需处理，只保留历史记录。</span>
    {_actionable_tasks_html(data.get("actionable_tasks") or [])}
  </section>

  <section class="grid-two">
    <div class="card">
      {_sec_h("任务阶段 / Verify / Review", "verify / review")}
      {_tasks_html((data.get("tasks") or []) if current_run_visible else [])}
    </div>
    <div class="card">
      {_sec_h("当前状态 / 下一步", "status / next")}
      <div class="kv-line"><span class="k">状态 status</span><span>{_pill(blocking.get("status"))}{blocking_status_help}</span></div>
      <div class="kv-line"><span class="k">下一步 next_action</span><span class="m">{_e(blocking.get("next_action") or "—")}</span></div>
      <div class="kv-foot">
        <span><span class="k">P0</span>= <span class="m">{_e(blocking.get("p0", 0))}</span></span>
        <span><span class="k">P1</span>= <span class="m">{_e(blocking.get("p1", 0))}</span></span>
      </div>
    </div>
  </section>

  <section class="card mt20">
    {_sec_h("最近 Runs", "recent runs")}
    <span class="section-hint">同一任务的多次独立尝试合并为一行，较早尝试收在展开明细中；run-loop 的 task 子运行也嵌套展示。最终 done / skipped 的任务无需处理，历史失败仅供追溯。</span>
    {recent_runs_html}
  </section>

  <section class="card mt20">
    {_sec_h(f"事件流（最近 {EVENT_LIMIT} 条）", "events")}
    <div class="events-wrap">{_events_html((data.get("events") or []) if current_run_visible else [])}</div>
  </section>

  <section class="card mt20">
    {_sec_h("Summary 摘要", "summary")}
    <p class="cell-sub" style="margin:0 0 10px">{_artifact_link(data.get("summary_path") or "") if current_run_visible else ""}</p>
    <div class="summary-box">{_e((data.get("summary_markdown") or "暂无 summary.md") if current_run_visible else "当前没有运行；历史摘要请在最近 Runs 中查看。")}</div>
  </section>
</div>
{_RECENT_RUNS_SCRIPT}
</body>
</html>
"""
    return html_text


def render_dashboard_html(
    data: dict[str, Any],
    *,
    refresh_seconds: int = 0,
    view: str = "overview",
    status_filter: str = "all",
    detail: str = "stages",
    page: int = 1,
) -> str:
    if view not in DASHBOARD_VIEWS:
        raise ValueError(f"unsupported dashboard view: {view}")
    allowed_status_filters = TASK_STATUS_FILTERS if view == "tasks" else RUN_STATUS_FILTERS
    if status_filter not in allowed_status_filters:
        noun = "task" if view == "tasks" else "run"
        raise ValueError(f"unsupported {noun} status filter: {status_filter}")
    if detail not in RUN_DETAIL_VIEWS:
        raise ValueError(f"unsupported run detail view: {detail}")
    if page < 1:
        raise ValueError("page must be a positive integer")

    projects = data.get("projects") or [{}]
    project = projects[0]
    queue = data.get("queue") or {}
    blocking = data.get("blocking") or {}
    recent = data.get("recent_runs") or []
    actionable = data.get("actionable_tasks") or []
    task_rows = data.get("task_rows") or actionable
    refresh_meta = f'<meta http-equiv="refresh" content="{refresh_seconds}">\n' if refresh_seconds > 0 else ""
    refreshed_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    live_text = f"· 每 {refresh_seconds} 秒自动刷新" if refresh_seconds > 0 else ""
    livedot = '<span class="livedot"></span>' if refresh_seconds > 0 else ""
    nav = _dashboard_nav_html(view, run_count=len(recent), action_count=len(actionable))
    queue_error_notice = (
        f'<div class="notice bad">队列读取失败 · queue unavailable: {_e(queue.get("error"))}</div>'
        if queue.get("error")
        else ""
    )

    if view == "runs" and str(data.get("run_kind") or "") == "selected":
        content = _run_detail_html(data, detail)
    elif view == "runs":
        filtered_runs = [
            item
            for item in recent
            if _run_matches_filter(item, status_filter)
        ]
        page_count = max(
            1,
            (len(filtered_runs) + RUN_PAGE_SIZE - 1) // RUN_PAGE_SIZE,
        )
        effective_page = min(page, page_count)
        page_start = (effective_page - 1) * RUN_PAGE_SIZE
        visible_runs = filtered_runs[
            page_start : page_start + RUN_PAGE_SIZE
        ]
        content = (
            '<section class="card mt20">'
            f'{_run_filter_html(recent, status_filter)}'
            f'{_runs_table_html(visible_runs, status_filter="all")}'
            f'{_run_pagination_html(total=len(filtered_runs), page=effective_page, status_filter=status_filter)}'
            '</section>'
        )
    elif view == "tasks":
        proposed = queue.get("proposed") or []
        proposed_text = ", ".join(str(item.get("id")) for item in proposed) if proposed else "none"
        task_source = actionable if status_filter == "all" else task_rows
        filtered_tasks = [
            task
            for task in task_source
            if _task_matches_filter(task, status_filter)
        ]
        if status_filter in {"done", "skipped"}:
            filtered_tasks.sort(
                key=lambda task: (
                    str(task.get("finished_at") or ""),
                    str(task.get("task_id") or ""),
                ),
                reverse=True,
            )
        task_heading = {
            "done": ("已完成任务", "completed history"),
            "skipped": ("已跳过任务", "skipped history"),
        }.get(status_filter, ("需要处理的任务", "action required"))
        task_hint = (
            "只读历史列表；可查看任务目标、完成时间、最近备注及关联 Run。"
            if status_filter in {"done", "skipped"}
            else "只显示 pending / in_progress / blocked；已完成和已跳过任务可通过筛选查看。"
        )
        empty_message = {
            "done": "当前没有已完成任务。",
            "skipped": "当前没有已跳过任务。",
        }.get(status_filter, "")
        content = (
            '<section class="card mt20">'
            f'{_sec_h(*task_heading)}'
            f'<span class="section-hint">{_e(task_hint)}</span>'
            f'{_task_filter_html(task_rows, actionable, status_filter)}'
            f'{_actionable_tasks_html(filtered_tasks, detailed=True, empty_message=empty_message)}'
            '</section>'
            '<section class="card mt20">'
            f'{_sec_h("队列分布", "queue")}{queue_error_notice}'
            f'<div class="tiles queue-tiles">{_counts_html(queue.get("counts") or {})}</div>'
            '<div class="kv-foot">'
            f'<span><span class="k">下一个 next</span> <span class="m">{_e(queue.get("next") or "—")}</span></span>'
            f'<span><span class="k">已提议 proposed</span> <span class="m">{_e(proposed_text)}</span></span>'
            '</div></section>'
        )
    elif view == "events":
        current_run_visible = bool(data.get("current_run_visible"))
        events = (data.get("events") or []) if current_run_visible else []
        selected_id = str(data.get("run_id") or "") if current_run_visible else ""
        context = (
            f'<div class="notice">当前显示 Run：<a class="mono" href="{_e(_dashboard_query(view="runs", run_id=selected_id, detail="events"))}">{_e(selected_id)}</a></div>'
            if selected_id
            else '<div class="notice">当前没有活动或指定 Run；单个历史 Run 的事件请从 Runs 详情进入。</div>'
        )
        content = (
            '<section class="card mt20">'
            f'{_sec_h(f"事件流（最近 {EVENT_LIMIT} 条）", "events")}{context}'
            f'<div class="events-wrap">{_events_html(events)}</div>'
            '</section>'
        )
    else:
        execution = _overview_execution_html(data)
        overview_notice = ""
        if queue.get("error"):
            overview_notice = queue_error_notice
        elif str(data.get("run_kind") or "") == "stale":
            overview_notice = (
                '<div class="notice bad"><strong>中断残留 Run</strong> · '
                '本机没有 AutoDev controller 进程或有效 heartbeat lease。 '
                f'{_e(blocking.get("next_action") or "请检查残留状态。")}'
                '</div>'
            )
        elif actionable and blocking.get("next_action"):
            overview_notice = (
                '<div class="notice warn"><strong>当前下一步</strong> · '
                f'{_e(blocking.get("next_action"))}</div>'
            )
        action_section = (
            '<section class="card mt20">'
            f'{_sec_h("需要处理的任务", "action required")}{_actionable_tasks_html(actionable)}'
            '</section>'
            if actionable
            else ""
        )
        content = (
            f'{overview_notice}'
            '<section class="card mt20">'
            f'{_sec_h("执行状态", "workers")}{execution}'
            '</section>'
            f'{action_section}'
            '<section class="card mt20">'
            '<div class="section-title-row">'
            f'{_sec_h("最近 Runs", "recent")}'
            f'<a href="{_e(_dashboard_query(view="runs"))}">查看全部 {len(recent)} 个 →</a>'
            '</div>'
            f'{_runs_table_html(recent, status_filter="all", limit=5)}'
            '</section>'
        )

    html_text = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
{refresh_meta}<meta http-equiv="Cache-Control" content="no-store">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoDev 只读状态页</title>
<style>{_DASHBOARD_CSS}</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="title-row">
      <h1>AutoDev <span class="accent">Harness</span></h1>
      <span class="badge">只读 <span class="en">read-only</span></span>
      <span class="project-chip" title="{_e(project.get('repo_root'))}">
        <strong>{_e(project.get('name'))}</strong>
        <span class="mono">{_e(project.get('id'))}</span>
        {_pill(project.get('status') or 'ok')}
      </span>
    </div>
    <div class="header-live">
      <span>{livedot}<span>刷新时间</span> <span class="mono">{_e(refreshed_at)}</span> <span class="dim">{_e(live_text)}</span></span>
      <span><span class="dim">Harness 状态</span> {_pill(blocking.get('status') or 'no_run', large=True)}</span>
    </div>
  </header>
  {_kpi_strip_html(data)}
  {nav}
  {content}
</div>
</body>
</html>
"""
    return html_text


def write_dashboard(
    config: AutoDevConfig,
    *,
    run_id: str = "",
    output: str | Path = DEFAULT_OUTPUT,
    registry_path: str | Path | None = None,
) -> Path:
    data = collect_dashboard_data(config, run_id=run_id, registry_path=registry_path)
    html_text = render_dashboard_html(data, view="runs" if run_id else "overview")
    target = Path(output)
    if not target.is_absolute():
        target = config.project.repo_root / target
    atomic_write_text(target, html_text)
    return target


class _DashboardRequestHandler(BaseHTTPRequestHandler):
    config: AutoDevConfig
    registry_path: str
    run_id: str
    refresh_seconds: int
    snapshot_cache: _DashboardSnapshotCache

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send_text(self, status: HTTPStatus, text: str, *, content_type: str = "text/plain; charset=utf-8") -> None:
        body = text.encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self._send_text(HTTPStatus.OK, "ok\n")
            return
        if parsed.path not in {"/", "/dashboard.html"}:
            self._send_text(HTTPStatus.NOT_FOUND, "not found\n")
            return
        query = parse_qs(parsed.query)
        run_id = (query.get("run_id") or [self.run_id])[0]
        view = (query.get("view") or ["runs" if run_id else "overview"])[0]
        status_filter = (query.get("status") or ["all"])[0]
        detail = (query.get("detail") or ["stages"])[0]
        try:
            page_text = (query.get("page") or ["1"])[0]
            try:
                page = int(page_text)
            except ValueError as exc:
                raise ValueError(
                    "page must be a positive integer"
                ) from exc
            if page < 1:
                raise ValueError("page must be a positive integer")
            collection_page = page if view == "runs" and not run_id else 1
            collection_status = (
                status_filter
                if view == "runs" and not run_id
                else "all"
            )
            snapshot_key = (
                str(self.config.project.repo_root),
                run_id,
                self.registry_path,
                collection_page,
                collection_status,
            )
            data = self.snapshot_cache.get(
                snapshot_key,
                lambda: collect_dashboard_data(
                    self.config,
                    run_id=run_id,
                    run_page=collection_page,
                    run_status_filter=collection_status,
                    registry_path=self.registry_path or None,
                ),
            )
            html_text = render_dashboard_html(
                data,
                refresh_seconds=self.refresh_seconds,
                view=view,
                status_filter=status_filter,
                detail=detail,
                page=page,
            )
        except ValueError as exc:
            self._send_text(HTTPStatus.BAD_REQUEST, str(exc) + "\n")
            return
        except Exception as exc:
            self._send_text(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc) + "\n")
            return
        self._send_text(HTTPStatus.OK, html_text, content_type="text/html; charset=utf-8")


def serve_dashboard(
    config: AutoDevConfig,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    run_id: str = "",
    registry_path: str | Path | None = None,
    refresh_seconds: int = 5,
) -> None:
    run_id = _validate_run_id(run_id)
    snapshot_cache = _DashboardSnapshotCache(
        min(5.0, max(1.0, float(refresh_seconds)))
    )
    handler = type(
        "AutoDevDashboardHandler",
        (_DashboardRequestHandler,),
        {
            "config": config,
            "registry_path": str(registry_path or ""),
            "run_id": run_id,
            "refresh_seconds": refresh_seconds,
            "snapshot_cache": snapshot_cache,
        },
    )
    server = ThreadingHTTPServer((host, port), handler)
    url = f"http://{host}:{server.server_port}/"
    print(url, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Render a read-only AutoDev dashboard")
    parser.add_argument("--project", default="", help="AutoDev project config path")
    parser.add_argument("--registry", default="", help="AutoDev project registry path for multi-project dashboard")
    parser.add_argument("--run-id", default="", help="Run id; defaults to latest")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Dashboard HTML output path")
    parser.add_argument("--serve", action="store_true", help="Run a local read-only auto-refresh dashboard server")
    parser.add_argument("--host", default="127.0.0.1", help="Dashboard server host")
    parser.add_argument("--port", type=int, default=8765, help="Dashboard server port")
    parser.add_argument("--refresh-seconds", type=int, default=5, help="Auto-refresh interval for --serve")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        config = load_autodev_config(args.project or None)
        if args.serve:
            if args.refresh_seconds <= 0:
                raise ValueError("--refresh-seconds must be positive")
            serve_dashboard(
                config,
                host=args.host,
                port=args.port,
                run_id=args.run_id,
                registry_path=args.registry or None,
                refresh_seconds=args.refresh_seconds,
            )
            return 0
        output = write_dashboard(config, run_id=args.run_id, output=args.output, registry_path=args.registry or None)
        print(output)
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
