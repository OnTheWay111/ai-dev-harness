"""Persistent run state and event store for AutoDev loops."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import sys
from typing import Any, Callable, TypeVar
import uuid
import warnings

import yaml

from autodev.config import AutoDevConfig, load_autodev_config
from autodev._internal.io import atomic_write_text, file_lock, locked_write_yaml, mutate_yaml
from autodev._internal.schema import ensure_schema_v1
from autodev._internal.time import now_iso


SCHEMA_VERSION = 1
RUNS_DIR = ".autodev/runs"
OUTPUTS_DIR = "outputs/autodev"
ALLOWED_CONCLUSION_ARTIFACTS = {"summary.md", "direction_review.md", "direction_review.yaml", "handoff.md"}
T = TypeVar("T")
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
TASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
OBSERVABILITY_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$")
TRACE_ID_PATTERN = re.compile(r"^(?!0{32}$)[0-9a-f]{32}$")
SPAN_ID_PATTERN = re.compile(r"^(?!0{16}$)[0-9a-f]{16}$")


class RunAlreadyExistsError(FileExistsError):
    """Raised when a caller tries to create an existing AutoDev run."""


class AutoDevRunSchemaError(ValueError):
    """Raised when a run document declares an unsupported schema version."""


class RunProjectionWarning(RuntimeWarning):
    """Database truth committed but a compatibility projection needs repair."""


def _worker_observability_context() -> dict[str, str] | None:
    raw = os.environ.get("HARNESS_OBSERVABILITY_CONTEXT", "").strip()
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid HARNESS_OBSERVABILITY_CONTEXT") from exc
    if not isinstance(value, dict):
        raise ValueError("invalid HARNESS_OBSERVABILITY_CONTEXT")
    allowed = {
        "schema_version", "process", "request_id", "goal_id", "issue_id",
        "run_id", "receipt_id", "trace_id", "span_id", "parent_span_id",
        "trace_flags",
    }
    if set(value) - allowed or value.get("schema_version") != "harness.observability.v1":
        raise ValueError("unsupported HARNESS_OBSERVABILITY_CONTEXT")
    required_ids = ("request_id", "run_id")
    optional_ids = ("goal_id", "issue_id", "receipt_id")
    if any(not OBSERVABILITY_ID_PATTERN.fullmatch(str(value.get(key, ""))) for key in required_ids):
        raise ValueError("invalid observability correlation identity")
    if any(
        key in value and not OBSERVABILITY_ID_PATTERN.fullmatch(str(value[key]))
        for key in optional_ids
    ):
        raise ValueError("invalid observability correlation identity")
    if not TRACE_ID_PATTERN.fullmatch(str(value.get("trace_id", ""))) or not SPAN_ID_PATTERN.fullmatch(str(value.get("span_id", ""))):
        raise ValueError("invalid observability trace identity")
    if value.get("trace_flags") not in {"00", "01"}:
        raise ValueError("invalid observability trace flags")
    return {
        "schema_version": "harness.observability.v1",
        "process": "worker",
        "request_id": str(value["request_id"]),
        **{key: str(value[key]) for key in optional_ids if key in value},
        "run_id": str(value["run_id"]),
        "trace_id": str(value["trace_id"]),
        "span_id": uuid.uuid4().hex[:16],
        "parent_span_id": str(value["span_id"]),
        "trace_flags": str(value["trace_flags"]),
    }


def validate_run_id(run_id: str) -> str:
    value = str(run_id or "")
    if not RUN_ID_PATTERN.fullmatch(value):
        raise ValueError("invalid run_id; expected 1-128 characters matching ^[A-Za-z0-9][A-Za-z0-9_-]*$")
    return value


def validate_task_id(task_id: str) -> str:
    value = str(task_id or "")
    if not TASK_ID_PATTERN.fullmatch(value):
        raise ValueError(
            "invalid task_id; expected 1-128 characters matching "
            "^[A-Za-z0-9][A-Za-z0-9_.-]*$"
        )
    return value


@dataclass(frozen=True)
class AutoDevRunPaths:
    run_id: str
    run_dir: Path
    run_yaml: Path
    events_jsonl: Path
    tasks_dir: Path
    output_dir: Path


def runs_root(repo_root: Path) -> Path:
    return repo_root / RUNS_DIR


def outputs_root(repo_root: Path) -> Path:
    return repo_root / OUTPUTS_DIR


def run_paths(repo_root: Path, run_id: str) -> AutoDevRunPaths:
    run_id = validate_run_id(run_id)
    run_dir = runs_root(repo_root) / run_id
    return AutoDevRunPaths(
        run_id=run_id,
        run_dir=run_dir,
        run_yaml=run_dir / "run.yaml",
        events_jsonl=run_dir / "events.jsonl",
        tasks_dir=run_dir / "tasks",
        output_dir=outputs_root(repo_root) / run_id,
    )


def _default_run(config: AutoDevConfig, run_id: str) -> dict[str, Any]:
    timestamp = now_iso()
    builder = config.agent.builder
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "project_id": config.project.id,
        "status": "created",
        "started_at": timestamp,
        "updated_at": timestamp,
        "budget": {
            "max_tasks": config.policy.max_tasks_per_loop,
            "max_tasks_after_direction_gate": config.policy.max_tasks_per_loop_after_direction_gate,
            "max_minutes": config.policy.max_minutes_per_loop,
            "task_timeout_minutes": builder.timeout_minutes,
            "verify_timeout_minutes": config.verify.command_timeout_minutes,
            "max_turns": builder.max_turns,
        },
        "git": {
            "base_ref": config.branch.base_ref,
            "base_sha": "",
            "branch": "",
            "worktree_path": "",
            "main_worktree_dirty_at_start": config.policy.main_worktree_dirty_policy,
        },
        "current_task": {
            "id": "",
            "status": "",
            "commit": "",
            "agent_selection": {},
        },
        "summary": {
            "tasks_done": 0,
            "tasks_blocked": 0,
            "consecutive_failures": 0,
            "token_usage": {},
            "findings": {
                "p0": 0,
                "p1": 0,
            },
        },
        "direction_check": {
            "mode": config.policy.direction_check.mode,
            "every_done_tasks": config.policy.direction_check.every_done_tasks,
            "last_checked_done_count": 0,
            "verdict": "on_track",
        },
        "next_action": "",
    }


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _warn_projection(operation: str, exc: Exception) -> None:
    warnings.warn(
        f"database run compatibility projection {operation} failed "
        f"({type(exc).__name__})",
        RunProjectionWarning,
        stacklevel=3,
    )


def _write_projection(paths: AutoDevRunPaths, run: dict[str, Any]) -> None:
    try:
        locked_write_yaml(paths.run_yaml, run)
    except Exception as exc:
        _warn_projection("write", exc)


def _database_store_for_config(config: AutoDevConfig, persistence):
    from autodev.database.composition import run_store_for_config

    return run_store_for_config(config, database_config=persistence)


def _database_store_for_repo(repo_root: Path, persistence):
    from autodev.database.composition import run_store_for_repo

    return run_store_for_repo(repo_root, database_config=persistence)


def create_run(config: AutoDevConfig, run_id: str, *, initial: dict[str, Any] | None = None) -> AutoDevRunPaths:
    from autodev.database.config import MODE_DATABASE
    from autodev.database.shadow import (
        mirror_snapshot,
        resolve_persistence_config,
    )
    from autodev.persistence import PersistenceConflictError

    persistence = resolve_persistence_config()
    run_id = validate_run_id(run_id)
    paths = run_paths(config.project.repo_root, run_id)
    run = _default_run(config, run_id)
    if initial:
        run = _deep_merge(run, initial)
    run["updated_at"] = now_iso()
    ensure_schema_v1(run, label="AutoDev run", error_type=AutoDevRunSchemaError)

    paths.run_dir.parent.mkdir(parents=True, exist_ok=True)
    try:
        paths.run_dir.mkdir(exist_ok=False)
    except FileExistsError as exc:
        raise RunAlreadyExistsError(
            f"AutoDev run already exists: {paths.run_dir}"
        ) from exc
    paths.tasks_dir.mkdir()
    output_dir_created = not paths.output_dir.exists()
    paths.output_dir.mkdir(parents=True, exist_ok=True)
    if persistence.mode == MODE_DATABASE:
        try:
            _database_store_for_config(config, persistence).create(run_id, run)
        except PersistenceConflictError as exc:
            shutil.rmtree(paths.run_dir)
            if output_dir_created:
                shutil.rmtree(paths.output_dir)
            raise RunAlreadyExistsError(
                f"AutoDev run already exists in database: {run_id}"
            ) from exc
        except BaseException:
            shutil.rmtree(paths.run_dir)
            if output_dir_created:
                shutil.rmtree(paths.output_dir)
            raise
        _write_projection(paths, run)
        try:
            atomic_write_text(paths.events_jsonl, "")
        except Exception as exc:
            _warn_projection("initialize events", exc)
        return paths

    locked_write_yaml(paths.run_yaml, run)
    if not paths.events_jsonl.exists():
        atomic_write_text(paths.events_jsonl, "")
    mirror_snapshot(
        config.project.repo_root,
        run_id,
        paths.run_yaml,
        config=persistence,
    )
    return paths


def load_run(repo_root: Path, run_id: str) -> dict[str, Any]:
    from autodev.database.config import MODE_DATABASE
    from autodev.database.shadow import (
        resolve_persistence_config,
    )

    persistence = resolve_persistence_config()
    if persistence.mode == MODE_DATABASE:
        data = dict(
            _database_store_for_repo(repo_root, persistence).load(
                validate_run_id(run_id)
            )
        )
        ensure_schema_v1(
            data, label="AutoDev run", error_type=AutoDevRunSchemaError
        )
        return data
    path = run_paths(repo_root, run_id).run_yaml
    if not path.exists():
        raise FileNotFoundError(f"AutoDev run not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError(f"AutoDev run must be a mapping: {path}")
    ensure_schema_v1(data, label="AutoDev run", error_type=AutoDevRunSchemaError)
    return data


def mutate_run(repo_root: Path, run_id: str, mutator: Callable[[dict[str, Any]], T]) -> tuple[dict[str, Any], T]:
    from autodev.database.config import MODE_DATABASE
    from autodev.database.shadow import (
        mirror_snapshot,
        resolve_persistence_config,
    )

    persistence = resolve_persistence_config()
    if persistence.mode == MODE_DATABASE:
        run_id = validate_run_id(run_id)

        def _apply_database(run: dict[str, Any]) -> T:
            ensure_schema_v1(
                run, label="AutoDev run", error_type=AutoDevRunSchemaError
            )
            result = mutator(run)
            ensure_schema_v1(
                run, label="AutoDev run", error_type=AutoDevRunSchemaError
            )
            run["updated_at"] = now_iso()
            return result

        run, result = _database_store_for_repo(
            repo_root, persistence
        ).mutate(run_id, _apply_database)
        value = dict(run)
        _write_projection(run_paths(repo_root, run_id), value)
        return value, result
    path = run_paths(repo_root, run_id).run_yaml
    if not path.exists():
        raise FileNotFoundError(f"AutoDev run not found: {path}")
    captured: dict[str, Any] = {}

    def _apply(run: dict[str, Any]) -> T:
        ensure_schema_v1(run, label="AutoDev run", error_type=AutoDevRunSchemaError)
        result = mutator(run)
        ensure_schema_v1(run, label="AutoDev run", error_type=AutoDevRunSchemaError)
        run["updated_at"] = now_iso()
        captured["run"] = run
        return result

    result = mutate_yaml(path, _apply)
    mirror_snapshot(repo_root, run_id, path, config=persistence)
    return captured["run"], result


def append_event(
    repo_root: Path,
    run_id: str,
    *,
    level: str,
    phase: str,
    message: str,
    task_id: str = "",
    artifact: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from autodev.database.config import MODE_DATABASE
    from autodev.database.shadow import (
        mirror_events,
        resolve_persistence_config,
    )

    persistence = resolve_persistence_config()
    paths = run_paths(repo_root, run_id)
    event = {
        "schema_version": "autodev.run-event.v1",
        "event_id": f"{validate_run_id(run_id)}:{uuid.uuid4().hex}",
        "timestamp": now_iso(),
        "level": level,
        "phase": phase,
        "task_id": task_id,
        "message": message,
        "artifact": artifact,
    }
    observability = _worker_observability_context()
    if observability:
        event["observability"] = observability
    if extra:
        event["extra"] = extra
    if persistence.mode == MODE_DATABASE:
        stored = dict(
            _database_store_for_repo(repo_root, persistence).append_event(
                validate_run_id(run_id), event
            )
        )
        stored.pop("_seq", None)
        try:
            paths.events_jsonl.parent.mkdir(parents=True, exist_ok=True)
            with file_lock(paths.events_jsonl):
                with paths.events_jsonl.open("a", encoding="utf-8") as handle:
                    handle.write(
                        json.dumps(
                            stored,
                            ensure_ascii=False,
                            sort_keys=True,
                        )
                        + "\n"
                    )
        except Exception as exc:
            _warn_projection("append event", exc)
        return stored
    paths.events_jsonl.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(paths.events_jsonl):
        sequence = 1
        if paths.events_jsonl.exists():
            with paths.events_jsonl.open("r", encoding="utf-8") as handle:
                sequence += sum(1 for line in handle if line.strip())
        event["sequence"] = sequence
        with paths.events_jsonl.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    mirror_events(
        repo_root,
        run_id,
        paths.run_yaml,
        paths.events_jsonl,
        config=persistence,
    )
    return event


def write_conclusion_artifact(repo_root: Path, run_id: str, filename: str, content: str) -> Path:
    from autodev.database.config import MODE_DATABASE
    from autodev.database.shadow import (
        mirror_artifact,
        resolve_persistence_config,
    )

    persistence = resolve_persistence_config()
    if filename not in ALLOWED_CONCLUSION_ARTIFACTS:
        allowed = ", ".join(sorted(ALLOWED_CONCLUSION_ARTIFACTS))
        raise ValueError(f"unsupported conclusion artifact: {filename}; allowed: {allowed}")
    target = run_paths(repo_root, run_id).output_dir / filename
    with file_lock(target):
        atomic_write_text(target, content)
    if persistence.mode == MODE_DATABASE:
        from autodev.database.run_repository import DatabaseArtifactIndex

        DatabaseArtifactIndex(
            _database_store_for_repo(repo_root, persistence)
        ).index_file(
            validate_run_id(run_id),
            target,
            logical_name=filename,
            kind="conclusion",
        )
        return target
    mirror_artifact(
        repo_root,
        run_id,
        run_paths(repo_root, run_id).run_yaml,
        target,
        kind="conclusion",
        config=persistence,
    )
    return target


def latest_run_id(repo_root: Path) -> str:
    from autodev.database.config import MODE_DATABASE
    from autodev.database.shadow import (
        resolve_persistence_config,
    )

    persistence = resolve_persistence_config()
    if persistence.mode == MODE_DATABASE:
        rows = _database_store_for_repo(repo_root, persistence).list_recent(
            limit=1
        )
        return str(rows[0].get("run_id") or "") if rows else ""
    candidates = sorted(
        (path.parent for path in runs_root(repo_root).glob("*/run.yaml")),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        return ""
    return candidates[0].name


def status_summary(repo_root: Path, run_id: str) -> dict[str, Any]:
    run = load_run(repo_root, run_id)
    return {
        "run_id": run.get("run_id", run_id),
        "project_id": run.get("project_id", ""),
        "status": run.get("status", ""),
        "updated_at": run.get("updated_at", ""),
        "current_task": run.get("current_task", {}),
        "summary": run.get("summary", {}),
        "next_action": run.get("next_action", ""),
    }


def _print_status(summary: dict[str, Any]) -> None:
    current = summary.get("current_task") or {}
    run_summary = summary.get("summary") or {}
    findings = run_summary.get("findings") or {}
    print(f"run_id: {summary.get('run_id')}")
    print(f"project_id: {summary.get('project_id')}")
    print(f"status: {summary.get('status')}")
    print(f"updated_at: {summary.get('updated_at')}")
    print(
        "current_task: "
        f"{current.get('id') or '-'} "
        f"({current.get('status') or '-'})"
    )
    print(
        "summary: "
        f"done={run_summary.get('tasks_done', 0)} "
        f"blocked={run_summary.get('tasks_blocked', 0)} "
        f"failures={run_summary.get('consecutive_failures', 0)} "
        f"p0={findings.get('p0', 0)} "
        f"p1={findings.get('p1', 0)}"
    )
    print(f"next_action: {summary.get('next_action') or '-'}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AutoDev run store utilities")
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status", help="Show latest or selected AutoDev run status")
    status.add_argument("--project", default="", help="AutoDev project config path")
    status.add_argument("--run-id", default="", help="Run id; defaults to latest run")
    status.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "status":
            config = load_autodev_config(args.project or None)
            run_id = args.run_id or latest_run_id(config.project.repo_root)
            if not run_id:
                print("no AutoDev runs found", file=sys.stderr)
                return 1
            summary = status_summary(config.project.repo_root, run_id)
            if args.json:
                print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
            else:
                _print_status(summary)
            return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
