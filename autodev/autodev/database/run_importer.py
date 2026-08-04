"""Idempotent file Run importer and shadow digest reconciliation."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

import yaml
from sqlalchemy import select

from autodev.run_store import outputs_root, run_paths, runs_root, validate_run_id

from .models import ImportBatch
from .run_repository import (
    DatabaseArtifactIndex,
    DatabaseRunStore,
    canonical_digest,
    file_sha256,
)


@dataclass(frozen=True)
class RunImportSummary:
    project_key: str
    source_digest: str
    runs_seen: int
    snapshots_changed: int
    events_added: int
    artifacts_indexed: int
    already_imported: bool = False

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


def _load_snapshot(path: Path) -> dict[str, Any]:
    value = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(value, dict):
        raise ValueError(f"run snapshot must be a mapping: {path}")
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def _load_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError(f"run event must be an object: {path}:{line_number}")
        events.append(value)
    return events


def _artifact_paths(repo_root: Path, run_id: str) -> Iterable[Path]:
    paths = run_paths(repo_root, run_id)
    roots = (paths.tasks_dir, paths.output_dir)
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*")):
            if path.is_file() and not path.name.endswith(".lock"):
                resolved = path.resolve(strict=True)
                if resolved not in seen:
                    seen.add(resolved)
                    yield resolved


def _source_digest(repo_root: Path) -> str:
    entries: list[list[Any]] = []
    root = runs_root(repo_root)
    for run_yaml in sorted(root.glob("*/run.yaml")):
        run_id = validate_run_id(run_yaml.parent.name)
        paths = run_paths(repo_root, run_id)
        for selected in (paths.run_yaml, paths.events_jsonl, *_artifact_paths(repo_root, run_id)):
            if selected.exists():
                entries.append(
                    [
                        str(selected.resolve(strict=True)),
                        selected.stat().st_size,
                        file_sha256(selected),
                    ]
                )
    return canonical_digest(entries)


def file_digest_record(repo_root: Path, run_id: str) -> dict[str, str]:
    paths = run_paths(repo_root, run_id)
    snapshot = _load_snapshot(paths.run_yaml)
    events = _load_events(paths.events_jsonl)
    artifacts = [
        [path.as_uri(), file_sha256(path), path.stat().st_size]
        for path in sorted(_artifact_paths(repo_root, run_id), key=lambda item: item.as_uri())
    ]
    return {
        "snapshot": canonical_digest(snapshot),
        "events": canonical_digest([canonical_digest(event) for event in events]),
        "artifacts": canonical_digest(artifacts),
    }


class RunFileImporter:
    def __init__(self, store: DatabaseRunStore, repo_root: str | Path) -> None:
        self.store = store
        self.repo_root = Path(repo_root).expanduser().resolve(strict=False)
        self.artifacts = DatabaseArtifactIndex(store)

    def _validated_snapshot(self, path: Path) -> dict[str, Any]:
        snapshot = _load_snapshot(path)
        project_id = str(snapshot.get("project_id") or "")
        if project_id != self.store.project.project_key:
            raise ValueError(
                "run snapshot project_id does not match the selected database project"
            )
        return snapshot

    def import_all(self) -> RunImportSummary:
        source_digest = _source_digest(self.repo_root)
        batch_key = f"runs:{self.store.project.project_key}:{source_digest}"
        with self.store.database.unit_of_work() as session:
            existing = session.scalar(
                select(ImportBatch).where(ImportBatch.idempotency_key == batch_key)
            )
            if existing is not None and existing.status == "completed":
                prior = dict(existing.summary or {})
                return RunImportSummary(
                    project_key=self.store.project.project_key,
                    source_digest=source_digest,
                    runs_seen=int(prior.get("runs_seen") or 0),
                    snapshots_changed=0,
                    events_added=0,
                    artifacts_indexed=0,
                    already_imported=True,
                )
            if existing is None:
                existing = ImportBatch(
                    idempotency_key=batch_key,
                    source_kind="run_tree",
                    source_uri=self.repo_root.as_uri(),
                    source_digest=source_digest,
                    status="running",
                )
                session.add(existing)

        counters = {
            "runs_seen": 0,
            "snapshots_changed": 0,
            "events_added": 0,
            "artifacts_indexed": 0,
        }
        try:
            for run_yaml in sorted(runs_root(self.repo_root).glob("*/run.yaml")):
                run_id = validate_run_id(run_yaml.parent.name)
                counters["runs_seen"] += 1
                snapshot = self._validated_snapshot(run_yaml)
                _, changed = self.store.upsert_snapshot(
                    run_id, snapshot, source_uri=run_yaml.resolve(strict=True).as_uri()
                )
                counters["snapshots_changed"] += int(changed)
                for seq, event in enumerate(
                    _load_events(run_paths(self.repo_root, run_id).events_jsonl), 1
                ):
                    counters["events_added"] += int(
                        self.store.import_event(run_id, seq, event)
                    )
                for artifact in _artifact_paths(self.repo_root, run_id):
                    relative = artifact.relative_to(self.repo_root)
                    parts = relative.parts
                    task_id = parts[4] if len(parts) > 5 and parts[3] == "tasks" else ""
                    self.artifacts.index_file(
                        run_id,
                        artifact,
                        task_id=task_id,
                        logical_name=artifact.name,
                        kind="run_artifact",
                    )
                    counters["artifacts_indexed"] += 1
            summary = RunImportSummary(
                project_key=self.store.project.project_key,
                source_digest=source_digest,
                **counters,
            )
            with self.store.database.unit_of_work() as session:
                batch = session.scalar(
                    select(ImportBatch).where(ImportBatch.idempotency_key == batch_key)
                )
                if batch is None:
                    raise RuntimeError("import batch disappeared")
                batch.status = "completed"
                batch.summary = summary.to_dict()
                batch.error = None
            return summary
        except Exception as exc:
            with self.store.database.unit_of_work() as session:
                batch = session.scalar(
                    select(ImportBatch).where(ImportBatch.idempotency_key == batch_key)
                )
                if batch is not None:
                    batch.status = "failed"
                    batch.error = f"{type(exc).__name__}: run import failed"
            raise

    def reconcile(self) -> dict[str, Any]:
        runs: list[dict[str, Any]] = []
        ok = True
        for run_yaml in sorted(runs_root(self.repo_root).glob("*/run.yaml")):
            run_id = validate_run_id(run_yaml.parent.name)
            self._validated_snapshot(run_yaml)
            file_digest = file_digest_record(self.repo_root, run_id)
            database_digest = self.store.digest_record(run_id)
            matches = file_digest == database_digest
            ok = ok and matches
            runs.append(
                {
                    "run_id": run_id,
                    "ok": matches,
                    "file": file_digest,
                    "database": database_digest,
                }
            )
        return {"ok": ok, "project_key": self.store.project.project_key, "runs": runs}
