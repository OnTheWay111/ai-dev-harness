"""Transactional PostgreSQL/SQLAlchemy Run, Event, and Artifact repositories."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import socket
from typing import Any, Callable, Mapping, TypeVar

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from autodev.persistence import (
    PersistenceConflictError,
    PersistenceNotFoundError,
)

from .engine import Database
from .models import ArtifactIndex, Project, Run, RunEvent


T = TypeVar("T")


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class ProjectIdentity:
    project_key: str
    name: str
    repo_root: str
    repo_fingerprint: str
    host_id: str
    config_digest: str | None = None

    @classmethod
    def local(cls, project_key: str, repo_root: str | Path) -> "ProjectIdentity":
        resolved = str(Path(repo_root).expanduser().resolve(strict=False))
        return cls(
            project_key=project_key,
            name=project_key,
            repo_root=resolved,
            repo_fingerprint=hashlib.sha256(resolved.encode("utf-8")).hexdigest(),
            host_id=socket.gethostname(),
        )


class DatabaseRunStore:
    """A project-scoped store with row-lock version CAS and ordered events."""

    def __init__(self, database: Database, project: ProjectIdentity) -> None:
        self.database = database
        self.project = project

    def _project_row(self, session: Session) -> Project:
        row = session.scalar(
            select(Project).where(Project.project_key == self.project.project_key)
        )
        if row is None:
            row = Project(
                project_key=self.project.project_key,
                name=self.project.name,
                repo_root=self.project.repo_root,
                repo_fingerprint=self.project.repo_fingerprint,
                config_digest=self.project.config_digest,
                host_id=self.project.host_id,
            )
            session.add(row)
            session.flush()
            return row
        identity = (row.repo_root, row.repo_fingerprint)
        expected = (self.project.repo_root, self.project.repo_fingerprint)
        if identity != expected:
            raise PersistenceConflictError(
                f"project identity conflict for {self.project.project_key!r}"
            )
        row.name = self.project.name
        row.host_id = self.project.host_id
        row.config_digest = self.project.config_digest
        return row

    def ensure_project(self) -> int:
        with self.database.unit_of_work() as session:
            return self._project_row(session).id

    def _run_query(self, project_pk: int, run_id: str, *, lock: bool = False):
        statement = select(Run).where(
            Run.project_id == project_pk,
            Run.run_id == run_id,
        )
        return statement.with_for_update() if lock else statement

    def _locked_run(self, session: Session, project_pk: int, run_id: str) -> Run:
        row = session.scalar(self._run_query(project_pk, run_id, lock=True))
        if row is None:
            raise PersistenceNotFoundError(f"run not found: {run_id}")
        return row

    @staticmethod
    def _event_row(session: Session, run: Run, event: Mapping[str, Any]) -> RunEvent:
        seq = int(
            session.scalar(
                select(func.coalesce(func.max(RunEvent.seq), 0)).where(
                    RunEvent.run_pk == run.id
                )
            )
            or 0
        ) + 1
        payload = deepcopy(dict(event))
        row = RunEvent(
            run_pk=run.id,
            seq=seq,
            timestamp=str(payload.get("timestamp") or ""),
            level=str(payload.get("level") or "info"),
            phase=str(payload.get("phase") or ""),
            task_id=str(payload.get("task_id") or "") or None,
            event_digest=canonical_digest(payload),
            payload=payload,
        )
        session.add(row)
        return row

    def create(self, run_id: str, initial: Mapping[str, Any]) -> Mapping[str, Any]:
        snapshot = deepcopy(dict(initial))
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            if session.scalar(self._run_query(project.id, run_id)) is not None:
                raise PersistenceConflictError(f"run already exists: {run_id}")
            session.add(
                Run(
                    project_id=project.id,
                    run_id=run_id,
                    parent_run_id=str(snapshot.get("parent_run_id") or "") or None,
                    status=str(snapshot.get("status") or "created"),
                    version=1,
                    snapshot=snapshot,
                    snapshot_digest=canonical_digest(snapshot),
                )
            )
        return snapshot

    def load(self, run_id: str) -> Mapping[str, Any]:
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            row = session.scalar(self._run_query(project.id, run_id))
            if row is None:
                raise PersistenceNotFoundError(f"run not found: {run_id}")
            return deepcopy(row.snapshot)

    def version(self, run_id: str) -> int:
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            row = session.scalar(self._run_query(project.id, run_id))
            if row is None:
                raise PersistenceNotFoundError(f"run not found: {run_id}")
            return row.version

    def mutate(
        self,
        run_id: str,
        mutate: Callable[[dict[str, Any]], T],
        *,
        expected_version: int | None = None,
    ) -> tuple[Mapping[str, Any], T]:
        return self.mutate_with_event(
            run_id,
            mutate,
            expected_version=expected_version,
            event=None,
        )

    def mutate_with_event(
        self,
        run_id: str,
        mutate: Callable[[dict[str, Any]], T],
        *,
        expected_version: int | None = None,
        event: Mapping[str, Any] | None,
    ) -> tuple[Mapping[str, Any], T]:
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            row = self._locked_run(session, project.id, run_id)
            if expected_version is not None and row.version != expected_version:
                raise PersistenceConflictError(
                    f"run version conflict: expected {expected_version}, found {row.version}"
                )
            snapshot = deepcopy(row.snapshot)
            result = mutate(snapshot)
            row.snapshot = snapshot
            row.snapshot_digest = canonical_digest(snapshot)
            row.status = str(snapshot.get("status") or row.status)
            row.parent_run_id = str(snapshot.get("parent_run_id") or "") or None
            row.version += 1
            if event is not None:
                self._event_row(session, row, event)
            return deepcopy(snapshot), result

    def upsert_snapshot(
        self,
        run_id: str,
        snapshot: Mapping[str, Any],
        *,
        source_uri: str = "",
    ) -> tuple[Mapping[str, Any], bool]:
        value = deepcopy(dict(snapshot))
        digest = canonical_digest(value)
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            row = session.scalar(self._run_query(project.id, run_id, lock=True))
            if row is None:
                row = Run(
                    project_id=project.id,
                    run_id=run_id,
                    parent_run_id=str(value.get("parent_run_id") or "") or None,
                    status=str(value.get("status") or "created"),
                    version=1,
                    snapshot=value,
                    snapshot_digest=digest,
                    source_uri=source_uri or None,
                )
                session.add(row)
                return value, True
            if row.snapshot_digest == digest:
                return deepcopy(row.snapshot), False
            row.snapshot = value
            row.snapshot_digest = digest
            row.status = str(value.get("status") or row.status)
            row.parent_run_id = str(value.get("parent_run_id") or "") or None
            row.source_uri = source_uri or row.source_uri
            row.version += 1
            return value, True

    def append_event(self, run_id: str, event: Mapping[str, Any]) -> Mapping[str, Any]:
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            run = self._locked_run(session, project.id, run_id)
            row = self._event_row(session, run, event)
            session.flush()
            value = deepcopy(row.payload)
            value["_seq"] = row.seq
            return value

    def import_event(
        self, run_id: str, seq: int, event: Mapping[str, Any]
    ) -> bool:
        payload = deepcopy(dict(event))
        digest = canonical_digest(payload)
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            run = self._locked_run(session, project.id, run_id)
            existing = session.scalar(
                select(RunEvent).where(RunEvent.run_pk == run.id, RunEvent.seq == seq)
            )
            if existing is not None:
                if existing.event_digest != digest:
                    raise PersistenceConflictError(
                        f"run event conflict: run={run_id} seq={seq}"
                    )
                return False
            session.add(
                RunEvent(
                    run_pk=run.id,
                    seq=seq,
                    timestamp=str(payload.get("timestamp") or ""),
                    level=str(payload.get("level") or "info"),
                    phase=str(payload.get("phase") or ""),
                    task_id=str(payload.get("task_id") or "") or None,
                    event_digest=digest,
                    payload=payload,
                )
            )
            return True

    def sync_events(
        self, run_id: str, events: list[Mapping[str, Any]]
    ) -> int:
        """Idempotently reconcile an ordered file event stream in one transaction."""
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            run = self._locked_run(session, project.id, run_id)
            existing = {
                row.seq: row
                for row in session.scalars(
                    select(RunEvent).where(RunEvent.run_pk == run.id)
                ).all()
            }
            added = 0
            for seq, event in enumerate(events, 1):
                payload = deepcopy(dict(event))
                digest = canonical_digest(payload)
                row = existing.get(seq)
                if row is not None:
                    if row.event_digest != digest:
                        raise PersistenceConflictError(
                            f"run event conflict: run={run_id} seq={seq}"
                        )
                    continue
                session.add(
                    RunEvent(
                        run_pk=run.id,
                        seq=seq,
                        timestamp=str(payload.get("timestamp") or ""),
                        level=str(payload.get("level") or "info"),
                        phase=str(payload.get("phase") or ""),
                        task_id=str(payload.get("task_id") or "") or None,
                        event_digest=digest,
                        payload=payload,
                    )
                )
                added += 1
            if any(seq > len(events) for seq in existing):
                raise PersistenceConflictError(
                    f"database has events beyond file authority: run={run_id}"
                )
            return added

    def events(self, run_id: str) -> list[Mapping[str, Any]]:
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            run = self._locked_run(session, project.id, run_id)
            rows = session.scalars(
                select(RunEvent)
                .where(RunEvent.run_pk == run.id)
                .order_by(RunEvent.seq)
            ).all()
            return [deepcopy(row.payload) for row in rows]

    def list_recent(
        self, *, limit: int = 50, cursor: str = ""
    ) -> list[Mapping[str, Any]]:
        if cursor:
            raise ValueError("database run cursor is not implemented yet")
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            rows = session.scalars(
                select(Run)
                .where(Run.project_id == project.id)
                .order_by(Run.updated_at.desc(), Run.id.desc())
                .limit(limit)
            ).all()
            return [deepcopy(row.snapshot) for row in rows]

    def digest_record(self, run_id: str) -> dict[str, Any]:
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            run = self._locked_run(session, project.id, run_id)
            events = session.scalars(
                select(RunEvent)
                .where(RunEvent.run_pk == run.id)
                .order_by(RunEvent.seq)
            ).all()
            artifacts = session.scalars(
                select(ArtifactIndex)
                .where(ArtifactIndex.run_pk == run.id)
            ).all()
            artifacts = sorted(artifacts, key=lambda row: row.uri)
            return {
                "snapshot": run.snapshot_digest,
                "events": canonical_digest([row.event_digest for row in events]),
                "artifacts": canonical_digest(
                    [
                        [row.uri, row.content_sha256, row.size_bytes]
                        for row in artifacts
                    ]
                ),
            }


class DatabaseArtifactIndex:
    def __init__(self, run_store: DatabaseRunStore) -> None:
        self.run_store = run_store

    def index_file(
        self,
        run_id: str,
        path: str | Path,
        *,
        task_id: str = "",
        logical_name: str = "",
        kind: str = "artifact",
    ) -> Mapping[str, Any]:
        selected = Path(path).expanduser().resolve(strict=True)
        uri = selected.as_uri()
        digest = file_sha256(selected)
        size = selected.stat().st_size
        with self.run_store.database.unit_of_work() as session:
            project = self.run_store._project_row(session)
            run = self.run_store._locked_run(session, project.id, run_id)
            row = session.scalar(
                select(ArtifactIndex).where(
                    ArtifactIndex.run_pk == run.id,
                    ArtifactIndex.uri == uri,
                )
            )
            if row is None:
                row = ArtifactIndex(
                    run_pk=run.id,
                    task_id=task_id or None,
                    logical_name=logical_name or selected.name,
                    kind=kind,
                    uri=uri,
                    content_sha256=digest,
                    size_bytes=size,
                    version=1,
                )
                session.add(row)
            elif row.content_sha256 != digest or row.size_bytes != size:
                row.content_sha256 = digest
                row.size_bytes = size
                row.version += 1
            row.task_id = task_id or row.task_id
            row.logical_name = logical_name or row.logical_name
            row.kind = kind
            session.flush()
            return {
                "uri": row.uri,
                "sha256": row.content_sha256,
                "size": row.size_bytes,
                "version": row.version,
                "kind": row.kind,
                "task_id": row.task_id or "",
            }

    def sync_files(
        self,
        run_id: str,
        files: list[tuple[Path, str, str]],
    ) -> int:
        """Make artifact metadata exactly match the authoritative local files."""
        metadata = []
        for path, task_id, kind in files:
            selected = path.expanduser().resolve(strict=True)
            metadata.append(
                {
                    "path": selected,
                    "uri": selected.as_uri(),
                    "sha256": file_sha256(selected),
                    "size": selected.stat().st_size,
                    "task_id": task_id,
                    "kind": kind,
                }
            )
        with self.run_store.database.unit_of_work() as session:
            project = self.run_store._project_row(session)
            run = self.run_store._locked_run(session, project.id, run_id)
            rows = {
                row.uri: row
                for row in session.scalars(
                    select(ArtifactIndex).where(ArtifactIndex.run_pk == run.id)
                ).all()
            }
            changed = 0
            authoritative_uris = {item["uri"] for item in metadata}
            for item in metadata:
                row = rows.get(item["uri"])
                if row is None:
                    row = ArtifactIndex(
                        run_pk=run.id,
                        uri=item["uri"],
                        content_sha256=item["sha256"],
                        size_bytes=item["size"],
                        version=1,
                        task_id=item["task_id"] or None,
                        logical_name=item["path"].name,
                        kind=item["kind"],
                    )
                    session.add(row)
                    changed += 1
                else:
                    if (
                        row.content_sha256 != item["sha256"]
                        or row.size_bytes != item["size"]
                    ):
                        row.content_sha256 = item["sha256"]
                        row.size_bytes = item["size"]
                        row.version += 1
                        changed += 1
                    row.task_id = item["task_id"] or row.task_id
                    row.logical_name = item["path"].name
                    row.kind = item["kind"]
            stale = set(rows) - authoritative_uris
            if stale:
                session.execute(
                    delete(ArtifactIndex).where(
                        ArtifactIndex.run_pk == run.id,
                        ArtifactIndex.uri.in_(stale),
                    )
                )
                changed += len(stale)
            return changed
