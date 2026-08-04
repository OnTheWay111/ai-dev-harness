"""Best-effort file-authoritative shadow mirroring for Run persistence."""
from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
from typing import Any, Mapping
import warnings

import yaml

from .config import (
    DatabaseConfig,
    DatabaseConfigError,
    MODE_FILE,
    MODE_SHADOW,
    load_database_config,
    requested_persistence_mode,
)


class PersistenceShadowWarning(RuntimeWarning):
    """A file write succeeded but its database mirror needs reconciliation."""


_DATABASES: list[Any] = []
_ARTIFACT_SIGNATURES: dict[tuple[str, str], tuple[tuple[str, int, int], ...]] = {}


def resolve_persistence_config() -> DatabaseConfig:
    """Resolve mode without silently treating an unreadable host file as file."""
    try:
        return load_database_config()
    except DatabaseConfigError as exc:
        from .cutover import load_cutover_receipt

        if load_cutover_receipt() is not None:
            raise
        mode = requested_persistence_mode()
        if mode != MODE_SHADOW:
            raise
        _warn("configuration", exc)
        return DatabaseConfig(url=None, mode=MODE_FILE)


@lru_cache(maxsize=4)
def _cached_database(
    url: str,
    pool_size: int,
    max_overflow: int,
    pool_timeout: int,
    allow_sqlite: bool,
):
    from .engine import Database

    database = Database.from_config(
        DatabaseConfig(
            url=url,
            mode=MODE_SHADOW,
            allow_sqlite=allow_sqlite,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_timeout=pool_timeout,
        )
    )
    _DATABASES.append(database)
    return database


def _database(config: DatabaseConfig):
    return _cached_database(
        config.require_url(),
        config.pool_size,
        config.max_overflow,
        config.pool_timeout,
        config.allow_sqlite,
    )


def _snapshot(path: Path) -> dict[str, Any]:
    value = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(value, dict):
        raise ValueError("run snapshot is not a mapping")
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def _store(config: DatabaseConfig, repo_root: Path, project_id: str):
    from .run_repository import DatabaseRunStore, ProjectIdentity

    return DatabaseRunStore(
        _database(config),
        ProjectIdentity.local(project_id, repo_root),
    )


def _warn(operation: str, exc: Exception) -> None:
    warnings.warn(
        f"database shadow {operation} needs reconciliation ({type(exc).__name__})",
        PersistenceShadowWarning,
        stacklevel=3,
    )


def _sync_artifacts(store, repo_root: Path, run_id: str) -> None:
    from .run_importer import _artifact_paths
    from .run_repository import DatabaseArtifactIndex

    paths = list(_artifact_paths(repo_root, run_id))
    signature = tuple(
        (path.as_uri(), path.stat().st_size, path.stat().st_mtime_ns) for path in paths
    )
    key = (str(repo_root.resolve(strict=False)), run_id)
    if _ARTIFACT_SIGNATURES.get(key) == signature:
        return
    files: list[tuple[Path, str, str]] = []
    for path in paths:
        relative = path.relative_to(repo_root.resolve(strict=False))
        parts = relative.parts
        task_id = parts[4] if len(parts) > 5 and parts[3] == "tasks" else ""
        files.append((path, task_id, "run_artifact"))
    DatabaseArtifactIndex(store).sync_files(run_id, files)
    _ARTIFACT_SIGNATURES[key] = signature


def mirror_snapshot(
    repo_root: Path,
    run_id: str,
    run_yaml: Path,
    *,
    config: DatabaseConfig | None = None,
) -> None:
    selected = config or load_database_config()
    if selected.mode != MODE_SHADOW:
        return
    try:
        snapshot = _snapshot(run_yaml)
        project_id = str(snapshot.get("project_id") or "")
        if not project_id:
            raise ValueError("run snapshot has no project_id")
        store = _store(selected, repo_root, project_id)
        store.upsert_snapshot(
            run_id,
            snapshot,
            source_uri=run_yaml.resolve(strict=True).as_uri(),
        )
        _sync_artifacts(store, repo_root, run_id)
    except Exception as exc:
        _warn("snapshot", exc)


def mirror_events(
    repo_root: Path,
    run_id: str,
    run_yaml: Path,
    events_jsonl: Path,
    *,
    config: DatabaseConfig | None = None,
) -> None:
    selected = config or load_database_config()
    if selected.mode != MODE_SHADOW:
        return
    try:
        snapshot = _snapshot(run_yaml)
        project_id = str(snapshot.get("project_id") or "")
        store = _store(selected, repo_root, project_id)
        store.upsert_snapshot(
            run_id,
            snapshot,
            source_uri=run_yaml.resolve(strict=True).as_uri(),
        )
        events: list[Mapping[str, Any]] = []
        for seq, raw in enumerate(events_jsonl.read_text(encoding="utf-8").splitlines(), 1):
            if not raw.strip():
                continue
            event = json.loads(raw)
            if not isinstance(event, dict):
                raise ValueError("run event is not an object")
            events.append(event)
        store.sync_events(run_id, events)
        _sync_artifacts(store, repo_root, run_id)
    except Exception as exc:
        _warn("events", exc)


def mirror_artifact(
    repo_root: Path,
    run_id: str,
    run_yaml: Path,
    artifact: Path,
    *,
    task_id: str = "",
    kind: str = "artifact",
    config: DatabaseConfig | None = None,
) -> None:
    selected = config or load_database_config()
    if selected.mode != MODE_SHADOW:
        return
    try:
        snapshot = _snapshot(run_yaml)
        project_id = str(snapshot.get("project_id") or "")
        store = _store(selected, repo_root, project_id)
        store.upsert_snapshot(
            run_id,
            snapshot,
            source_uri=run_yaml.resolve(strict=True).as_uri(),
        )
        _sync_artifacts(store, repo_root, run_id)
    except Exception as exc:
        _warn("artifact", exc)


def dispose_shadow_engines() -> None:
    while _DATABASES:
        database = _DATABASES.pop()
        database.dispose()
    _cached_database.cache_clear()
    _ARTIFACT_SIGNATURES.clear()
