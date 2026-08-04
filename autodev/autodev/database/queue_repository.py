"""Transactional database QueuePort with manifest/runtime separation."""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import secrets
from typing import Any, Callable, Mapping, TypeVar

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from autodev._internal.time import now_iso
from autodev.adapters import queue_yaml
from autodev.adapters.queue_yaml import (
    DependencyBlockedError,
    InProgressExistsError,
    InvalidQueueError,
    InvalidTaskStatusError,
    LeaseConflictError,
    NoReadyTaskError,
    TaskNotFoundError,
)
from autodev.persistence import PersistenceConflictError
from autodev.queue_adapter import (
    QueueImportResult,
    QueueOperationResult,
    _error_result,
    _import_error_result,
    _task_snapshot,
)
from autodev.queue_import import (
    QueueImportConflictError,
    build_queue_tasks,
    import_id,
    validate_idempotency_key,
    validate_import_request,
    validate_stored_receipt,
)

from .engine import Database
from .models import ImportBatch, Project, QueueManifest, QueueTask, QueueTaskEvent
from .run_repository import ProjectIdentity, canonical_digest


T = TypeVar("T")

SPEC_FIELDS = frozenset(
    {
        "id",
        "title",
        "priority",
        "area",
        "goal",
        "preferred_builder",
        "dependencies",
        "exclusive_resources",
        "acceptance",
        "verify",
        "source",
        "acceptance_contract",
        "development_prompt",
        "completion_evidence",
        "expected_files",
        "execution_wave",
        "model_route",
    }
)


def _split_task(task: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    value = deepcopy(dict(task))
    spec = {key: value[key] for key in SPEC_FIELDS if key in value}
    runtime = {key: item for key, item in value.items() if key not in SPEC_FIELDS}
    return spec, runtime


def _task_value(row: QueueTask) -> dict[str, Any]:
    return {**deepcopy(row.spec), **deepcopy(row.runtime)}


def _authority_document(queue: Mapping[str, Any]) -> dict[str, Any]:
    """Return only Queue fields represented by the database authority.

    File adapters maintain root metadata such as ``updated_at`` when they
    rewrite YAML. That timestamp is not Queue state and has no database
    representation, so it must not make an otherwise exact frozen cutover
    digest fail. Any future authoritative root field must be added here and
    to ``_queue_document`` together so cutover remains fail-closed.
    """
    return {
        "schema_version": int(queue.get("schema_version") or 1),
        "policy": deepcopy(queue.get("policy") or {}),
        "tasks": deepcopy(list(queue.get("tasks") or [])),
    }


def _priority_rank(task: Mapping[str, Any]) -> int:
    return queue_yaml.PRIORITY_ORDER.get(str(task.get("priority") or "P2"), 2)


class DatabaseQueueRepository:
    """Project-scoped queue repository.

    A manifest row is locked before task rows for every mutation. This fixed
    lock order serializes admission decisions inside one project, so
    ``max_in_progress`` remains true across independent PostgreSQL sessions.
    """

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
        if (row.repo_root, row.repo_fingerprint) != (
            self.project.repo_root,
            self.project.repo_fingerprint,
        ):
            raise PersistenceConflictError(
                f"project identity conflict for {self.project.project_key!r}"
            )
        return row

    @staticmethod
    def _manifest_query(project_pk: int, *, lock: bool = False):
        statement = select(QueueManifest).where(
            QueueManifest.project_id == project_pk
        )
        return statement.with_for_update() if lock else statement

    def _state(
        self, session: Session, *, lock: bool
    ) -> tuple[Project, QueueManifest, list[QueueTask]]:
        project = self._project_row(session)
        manifest = session.scalar(self._manifest_query(project.id, lock=lock))
        if manifest is None:
            raise FileNotFoundError(
                f"database queue not initialized: {self.project.project_key}"
            )
        task_query = (
            select(QueueTask)
            .where(QueueTask.project_id == project.id)
            .order_by(QueueTask.ordinal, QueueTask.task_id)
        )
        if lock:
            task_query = task_query.with_for_update()
        rows = session.scalars(task_query).all()
        return project, manifest, list(rows)

    def _locked_state(
        self, session: Session
    ) -> tuple[Project, QueueManifest, list[QueueTask]]:
        return self._state(session, lock=True)

    def _read_state(
        self, session: Session
    ) -> tuple[Project, QueueManifest, list[QueueTask]]:
        return self._state(session, lock=False)

    @staticmethod
    def _queue_document(
        manifest: QueueManifest, rows: list[QueueTask]
    ) -> dict[str, Any]:
        return {
            "schema_version": manifest.schema_version,
            "policy": deepcopy(manifest.policy),
            "tasks": [_task_value(row) for row in rows],
        }

    @staticmethod
    def _row_by_id(rows: list[QueueTask], task_id: str) -> QueueTask:
        for row in rows:
            if row.task_id == task_id:
                return row
        raise TaskNotFoundError(f"task not found: {task_id}")

    @staticmethod
    def _ready_rows(rows: list[QueueTask]) -> list[QueueTask]:
        terminal = {
            row.task_id
            for row in rows
            if row.status in queue_yaml.TERMINAL_STATUSES
        }
        ready = [
            row
            for row in rows
            if row.status == "pending"
            and all(
                str(dependency).strip() in terminal
                for dependency in row.spec.get("dependencies", []) or []
            )
        ]
        return sorted(ready, key=lambda row: (row.priority_rank, row.task_id))

    @staticmethod
    def _deps_ready(rows: list[QueueTask], row: QueueTask) -> bool:
        terminal = {
            item.task_id
            for item in rows
            if item.status in queue_yaml.TERMINAL_STATUSES
        }
        return all(
            str(dependency).strip() in terminal
            for dependency in row.spec.get("dependencies", []) or []
        )

    @staticmethod
    def _append_note(task: dict[str, Any], note: str) -> None:
        if note:
            task.setdefault("notes", []).append({"at": now_iso(), "text": note})

    @staticmethod
    def _release_lease(task: dict[str, Any]) -> None:
        task.pop("lease_token", None)
        task["lease_released_at"] = now_iso()

    @staticmethod
    def _require_active_lease(
        task: Mapping[str, Any],
        *,
        expected_owner: str,
        expected_lease_token: str,
        expected_revision: int | None,
    ) -> None:
        task_id = str(task.get("id") or "")
        if task.get("status") != "in_progress":
            raise LeaseConflictError(
                f"task lease is no longer active: {task_id} -> {task.get('status')}"
            )
        actual_token = str(task.get("lease_token") or "")
        if not actual_token:
            raise LeaseConflictError(
                f"legacy tokenless in_progress task requires explicit manual reconcile: {task_id}"
            )
        if not expected_owner or not expected_lease_token or expected_revision is None:
            raise LeaseConflictError(
                f"owner, lease token, and revision are required to finalize task: {task_id}"
            )
        if str(task.get("owner") or "") != expected_owner:
            raise LeaseConflictError(f"task lease owner changed: {task_id}")
        if actual_token != expected_lease_token:
            raise LeaseConflictError(f"task lease token changed: {task_id}")
        if int(task.get("revision") or 0) != expected_revision:
            raise LeaseConflictError(f"task revision changed: {task_id}")

    @staticmethod
    def _store_task(row: QueueTask, task: Mapping[str, Any]) -> None:
        value = deepcopy(dict(task))
        _, runtime = _split_task(value)
        row.runtime = runtime
        row.status = str(value.get("status") or "pending")
        row.owner = str(value.get("owner") or "") or None
        row.lease_token = str(value.get("lease_token") or "") or None
        row.revision = int(value.get("revision") or 0)

    @staticmethod
    def _append_event(
        session: Session,
        row: QueueTask,
        event_type: str,
        task: Mapping[str, Any],
    ) -> None:
        seq = int(
            session.scalar(
                select(func.coalesce(func.max(QueueTaskEvent.seq), 0)).where(
                    QueueTaskEvent.task_pk == row.id
                )
            )
            or 0
        ) + 1
        payload = {
            "task_id": row.task_id,
            "event": event_type,
            "status": str(task.get("status") or ""),
            "owner": str(task.get("owner") or ""),
            "revision": int(task.get("revision") or 0),
            "fencing_token": row.fencing_token,
            "at": now_iso(),
        }
        session.add(
            QueueTaskEvent(
                task_pk=row.id,
                seq=seq,
                event_type=event_type,
                event_digest=canonical_digest(payload),
                payload=payload,
            )
        )

    def import_manifest(
        self,
        queue: Mapping[str, Any],
        *,
        source_uri: str = "",
    ) -> dict[str, Any]:
        """Import reviewed declarations while preserving existing DB runtime."""
        document = deepcopy(dict(queue))
        queue_yaml._validate_queue(document)
        policy = deepcopy(document.get("policy") or {})
        max_in_progress = int(policy.get("max_in_progress") or 1)
        if max_in_progress <= 0:
            raise InvalidQueueError("policy.max_in_progress must be positive")
        tasks = list(document.get("tasks") or [])
        manifest_value = {
            "schema_version": int(document.get("schema_version") or 1),
            "policy": policy,
            "tasks": [_split_task(task)[0] for task in tasks],
        }
        digest = canonical_digest(manifest_value)
        with self.database.unit_of_work() as session:
            project = self._project_row(session)
            manifest = session.scalar(self._manifest_query(project.id, lock=True))
            if manifest is None:
                manifest = QueueManifest(
                    project_id=project.id,
                    schema_version=manifest_value["schema_version"],
                    max_in_progress=max_in_progress,
                    manifest_digest=digest,
                    source_uri=source_uri or None,
                    policy=policy,
                    version=1,
                )
                session.add(manifest)
                session.flush()
            else:
                manifest.schema_version = manifest_value["schema_version"]
                manifest.max_in_progress = max_in_progress
                manifest.policy = policy
                manifest.source_uri = source_uri or manifest.source_uri
                if manifest.manifest_digest != digest:
                    manifest.manifest_digest = digest
                    manifest.version += 1

            existing = {
                row.task_id: row
                for row in session.scalars(
                    select(QueueTask)
                    .where(QueueTask.project_id == project.id)
                    .with_for_update()
                ).all()
            }
            manifest_ids: set[str] = set()
            added = 0
            updated = 0
            for ordinal, task in enumerate(tasks):
                task_id = str(task.get("id") or "")
                manifest_ids.add(task_id)
                spec, runtime = _split_task(task)
                spec_digest = canonical_digest(spec)
                row = existing.get(task_id)
                if row is None:
                    row = QueueTask(
                        project_id=project.id,
                        task_id=task_id,
                        origin="manifest",
                        ordinal=ordinal,
                        priority_rank=_priority_rank(task),
                        spec=spec,
                        spec_digest=spec_digest,
                        runtime=runtime,
                        status=str(task.get("status") or "pending"),
                        owner=str(task.get("owner") or "") or None,
                        lease_token=str(task.get("lease_token") or "") or None,
                        revision=int(task.get("revision") or 0),
                        fencing_token=int(task.get("fencing_token") or 0),
                    )
                    session.add(row)
                    session.flush()
                    self._append_event(session, row, "manifest_imported", task)
                    added += 1
                    continue
                if row.origin != "manifest":
                    raise PersistenceConflictError(
                        f"manifest task conflicts with database proposal: {task_id}"
                    )
                row.ordinal = ordinal
                if row.spec_digest != spec_digest:
                    if row.status == "in_progress":
                        raise PersistenceConflictError(
                            f"cannot change manifest spec while task is claimed: {task_id}"
                        )
                    row.spec = spec
                    row.spec_digest = spec_digest
                    row.priority_rank = _priority_rank(task)
                    updated += 1

            missing = [
                row.task_id
                for row in existing.values()
                if row.origin == "manifest"
                and row.task_id not in manifest_ids
                and row.status not in queue_yaml.TERMINAL_STATUSES
            ]
            if missing:
                raise PersistenceConflictError(
                    "manifest removed non-terminal database tasks: "
                    + ", ".join(sorted(missing))
                )
            return {
                "manifest_digest": digest,
                "tasks_seen": len(tasks),
                "tasks_added": added,
                "specs_updated": updated,
            }

    def import_file(self, path: str | Path) -> dict[str, Any]:
        queue_path = Path(path).expanduser().resolve(strict=False)
        return self.import_manifest(
            queue_yaml.load_queue(queue_path),
            source_uri=queue_path.as_uri(),
        )

    def reconcile_manifest(self, queue: Mapping[str, Any]) -> dict[str, Any]:
        """Compare reviewed declarations with DB specs without changing runtime."""
        document = deepcopy(dict(queue))
        queue_yaml._validate_queue(document)
        expected_specs = {
            str(task.get("id") or ""): canonical_digest(_split_task(task)[0])
            for task in document.get("tasks", [])
        }
        expected_manifest = canonical_digest(
            {
                "schema_version": int(document.get("schema_version") or 1),
                "policy": deepcopy(document.get("policy") or {}),
                "tasks": [
                    _split_task(task)[0] for task in document.get("tasks", [])
                ],
            }
        )
        with self.database.unit_of_work() as session:
            _, manifest, rows = self._read_state(session)
            actual_specs = {
                row.task_id: row.spec_digest
                for row in rows
                if row.origin == "manifest"
            }
            missing = sorted(set(expected_specs) - set(actual_specs))
            extra_nonterminal = sorted(
                row.task_id
                for row in rows
                if row.origin == "manifest"
                and row.task_id not in expected_specs
                and row.status not in queue_yaml.TERMINAL_STATUSES
            )
            changed = sorted(
                task_id
                for task_id in set(expected_specs) & set(actual_specs)
                if expected_specs[task_id] != actual_specs[task_id]
            )
            ok = (
                expected_manifest == manifest.manifest_digest
                and not missing
                and not extra_nonterminal
                and not changed
            )
            return {
                "ok": ok,
                "manifest_match": expected_manifest == manifest.manifest_digest,
                "expected_manifest_digest": expected_manifest,
                "database_manifest_digest": manifest.manifest_digest,
                "missing_tasks": missing,
                "extra_nonterminal_tasks": extra_nonterminal,
                "changed_specs": changed,
            }

    def reconcile_file(self, path: str | Path) -> dict[str, Any]:
        return self.reconcile_manifest(queue_yaml.load_queue(path))

    def synchronize_file_authority(
        self,
        queue: Mapping[str, Any],
        *,
        source_uri: str = "",
    ) -> dict[str, Any]:
        """Copy a frozen file queue, including runtime, into the database.

        This is a one-way cutover operation. It deliberately refuses active
        claims and task-set drift rather than guessing how to merge two runtime
        authorities.
        """
        document = deepcopy(dict(queue))
        queue_yaml._validate_queue(document)
        document = _authority_document(document)
        file_tasks = {
            str(task.get("id") or ""): deepcopy(dict(task))
            for task in document.get("tasks", [])
        }
        if any(task.get("status") == "in_progress" for task in file_tasks.values()):
            raise PersistenceConflictError(
                "frozen queue synchronization requires no file in_progress tasks"
            )
        policy = deepcopy(document.get("policy") or {})
        manifest_value = {
            "schema_version": int(document.get("schema_version") or 1),
            "policy": policy,
            "tasks": [_split_task(task)[0] for task in document.get("tasks", [])],
        }
        with self.database.unit_of_work() as session:
            project, manifest, rows = self._locked_state(session)
            if any(row.status == "in_progress" for row in rows):
                raise PersistenceConflictError(
                    "frozen queue synchronization requires no database in_progress tasks"
                )
            database_ids = {row.task_id for row in rows}
            if database_ids != set(file_tasks):
                raise PersistenceConflictError(
                    "frozen queue task set differs between file and database"
                )
            manifest.schema_version = manifest_value["schema_version"]
            manifest.max_in_progress = int(policy.get("max_in_progress") or 1)
            manifest.policy = policy
            manifest.manifest_digest = canonical_digest(manifest_value)
            manifest.source_uri = source_uri or manifest.source_uri
            manifest.version += 1
            by_id = {row.task_id: row for row in rows}
            for ordinal, task in enumerate(document.get("tasks", [])):
                task_id = str(task.get("id") or "")
                row = by_id[task_id]
                if row.origin != "manifest":
                    raise PersistenceConflictError(
                        f"database-only proposal blocks frozen sync: {task_id}"
                    )
                spec, runtime = _split_task(task)
                row.ordinal = ordinal
                row.priority_rank = _priority_rank(task)
                row.spec = spec
                row.spec_digest = canonical_digest(spec)
                row.runtime = runtime
                row.status = str(task.get("status") or "pending")
                row.owner = str(task.get("owner") or "") or None
                row.lease_token = str(task.get("lease_token") or "") or None
                row.revision = int(task.get("revision") or 0)
                row.fencing_token = max(
                    row.fencing_token,
                    int(task.get("fencing_token") or 0),
                )
                self._append_event(session, row, "file_authority_synchronized", task)
            session.flush()
            stored = self._queue_document(manifest, rows)
            expected_digest = canonical_digest(document)
            database_digest = canonical_digest(stored)
            if database_digest != expected_digest:
                raise PersistenceConflictError(
                    "frozen queue digest mismatch after synchronization"
                )
            return {
                "ok": True,
                "project_pk": project.id,
                "tasks_seen": len(file_tasks),
                "file_digest": expected_digest,
                "database_digest": database_digest,
            }

    def synchronize_file(self, path: str | Path) -> dict[str, Any]:
        queue_path = Path(path).expanduser().resolve(strict=True)
        return self.synchronize_file_authority(
            queue_yaml.load_queue(queue_path),
            source_uri=queue_path.as_uri(),
        )

    def reconcile_full_file(self, path: str | Path) -> dict[str, Any]:
        queue_path = Path(path).expanduser().resolve(strict=True)
        expected = _authority_document(queue_yaml.load_queue(queue_path))
        with self.database.unit_of_work() as session:
            _, manifest, rows = self._read_state(session)
            actual = self._queue_document(manifest, rows)
        expected_digest = canonical_digest(expected)
        database_digest = canonical_digest(actual)
        return {
            "ok": expected_digest == database_digest,
            "file_digest": expected_digest,
            "database_digest": database_digest,
            "tasks_seen": len(expected.get("tasks", [])),
        }

    def summary(self) -> dict[str, Any]:
        with self.database.unit_of_work() as session:
            _, manifest, rows = self._read_state(session)
            return queue_yaml.queue_summary(self._queue_document(manifest, rows))

    def list_tasks(self) -> list[dict[str, Any]]:
        with self.database.unit_of_work() as session:
            _, _, rows = self._read_state(session)
            return [_task_value(row) for row in rows]

    def dashboard_snapshot(
        self,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        with self.database.unit_of_work() as session:
            _, manifest, rows = self._read_state(session)
            return (
                queue_yaml.queue_summary(self._queue_document(manifest, rows)),
                [_task_value(row) for row in rows],
            )

    def get_task(self, task_id: str) -> dict[str, Any]:
        with self.database.unit_of_work() as session:
            _, _, rows = self._read_state(session)
            return _task_value(self._row_by_id(rows, task_id))

    def ready_candidates(self, limit: int) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or limit <= 0:
            raise ValueError("ready candidate limit must be positive")
        with self.database.unit_of_work() as session:
            _, _, rows = self._read_state(session)
            return [_task_value(row) for row in self._ready_rows(rows)[:limit]]

    def mutate(
        self,
        event_type: str,
        operation: Callable[
            [Session, QueueManifest, list[QueueTask]], tuple[QueueTask, dict[str, Any]]
        ],
    ) -> dict[str, Any]:
        with self.database.unit_of_work() as session:
            _, manifest, rows = self._locked_state(session)
            row, task = operation(session, manifest, rows)
            self._store_task(row, task)
            self._append_event(session, row, event_type, task)
            return deepcopy(task)

    def claim(
        self,
        task_id: str = "",
        *,
        owner: str = "autodev",
        note: str = "",
        lease_token: str = "",
    ) -> dict[str, Any]:
        def operation(_session, manifest, rows):
            if task_id:
                existing = self._row_by_id(rows, task_id)
                if existing.status == "in_progress":
                    qualifier = "legacy tokenless " if not existing.lease_token else ""
                    raise InProgressExistsError(
                        f"{qualifier}in_progress task requires explicit reconcile before reclaim: {task_id}"
                    )
            if sum(row.status == "in_progress" for row in rows) >= manifest.max_in_progress:
                raise InProgressExistsError(
                    "已有 in_progress 任务，请先 done/block 当前任务"
                )
            row = self._row_by_id(rows, task_id) if task_id else (
                self._ready_rows(rows)[0] if self._ready_rows(rows) else None
            )
            if row is None:
                raise NoReadyTaskError("没有可领取的 pending 任务")
            task = _task_value(row)
            if task.get("status") != "pending":
                raise InvalidTaskStatusError(
                    f"任务不是 pending 状态: {row.task_id} -> {task.get('status')}"
                )
            if not self._deps_ready(rows, row):
                raise DependencyBlockedError(f"任务依赖未完成: {row.task_id}")
            row.fencing_token += 1
            task["status"] = "in_progress"
            task["owner"] = owner or "autodev"
            task["lease_token"] = lease_token or secrets.token_urlsafe(24)
            task["fencing_token"] = row.fencing_token
            task["claimed_spec_digest"] = row.spec_digest
            task["lease_acquired_at"] = now_iso()
            task["revision"] = int(task.get("revision") or 0) + 1
            task["started_at"] = task.get("started_at") or now_iso()
            task["updated_at"] = now_iso()
            self._append_note(task, note or f"{owner} claimed task")
            return row, task

        return self.mutate("claimed", operation)

    def done(
        self,
        task_id: str,
        *,
        note: str = "",
        artifacts: list[str] | None = None,
        expected_owner: str = "",
        expected_lease_token: str = "",
        expected_revision: int | None = None,
        force_reconcile: bool = False,
        review_passed: bool = False,
    ) -> dict[str, Any]:
        def operation(_session, _manifest, rows):
            row = self._row_by_id(rows, task_id)
            task = _task_value(row)
            if (
                task.get("required_gate") == queue_yaml.INDEPENDENT_REVIEW_GATE
                and not review_passed
            ):
                raise InvalidTaskStatusError(
                    f"task {task_id} requires independent review; resume it and run AutoDev "
                    "again instead of force-reconciling it to done"
                )
            if force_reconcile:
                if task.get("status") not in {"in_progress", "pending", "blocked"}:
                    raise InvalidTaskStatusError(
                        f"任务不能完成: {task_id} -> {task.get('status')}"
                    )
            else:
                self._require_active_lease(
                    task,
                    expected_owner=expected_owner,
                    expected_lease_token=expected_lease_token,
                    expected_revision=expected_revision,
                )
                if task.get("claimed_spec_digest") != row.spec_digest:
                    raise InvalidTaskStatusError(
                        f"task declaration changed after claim: {task_id}"
                    )
            task["status"] = "done"
            task["completion_mode"] = (
                "manual_reconcile" if force_reconcile else "autodev_reviewed"
            )
            task["revision"] = int(task.get("revision") or 0) + 1
            self._release_lease(task)
            task["finished_at"] = now_iso()
            task["updated_at"] = now_iso()
            task["blocked_reason"] = ""
            task["next_action"] = ""
            if not force_reconcile:
                task.pop("required_gate", None)
                task["autodev_failure_count"] = 0
                task.pop("last_autodev_failure", None)
            if artifacts:
                task.setdefault("artifacts", []).extend(artifacts)
            self._append_note(task, note or "done")
            return row, task

        return self.mutate("completed", operation)

    def block(
        self,
        task_id: str,
        *,
        reason: str,
        next_action: str = "",
        expected_owner: str = "",
        expected_lease_token: str = "",
        expected_revision: int | None = None,
        force_reconcile: bool = False,
        failure_status: str = "",
        failure_run_id: str = "",
    ) -> dict[str, Any]:
        def operation(_session, _manifest, rows):
            row = self._row_by_id(rows, task_id)
            task = _task_value(row)
            if task.get("status") in queue_yaml.TERMINAL_STATUSES:
                raise InvalidTaskStatusError(f"已结束任务不能阻塞: {task_id}")
            if task.get("status") == "proposed":
                raise InvalidTaskStatusError(
                    f"proposed 任务未批准，不能 block: {task_id}"
                )
            if not force_reconcile:
                self._require_active_lease(
                    task,
                    expected_owner=expected_owner,
                    expected_lease_token=expected_lease_token,
                    expected_revision=expected_revision,
                )
            task["status"] = "blocked"
            task["revision"] = int(task.get("revision") or 0) + 1
            self._release_lease(task)
            task["blocked_reason"] = reason
            task["next_action"] = next_action
            if failure_status:
                count = int(task.get("autodev_failure_count") or 0) + 1
                task["autodev_failure_count"] = count
                task["last_autodev_failure"] = {
                    "status": failure_status,
                    "at": now_iso(),
                    "count": count,
                }
                if failure_run_id:
                    task["last_autodev_failure"]["run_id"] = failure_run_id
                if failure_status in queue_yaml.REVIEW_GATED_FAILURE_STATUSES:
                    task["required_gate"] = queue_yaml.INDEPENDENT_REVIEW_GATE
            task["updated_at"] = now_iso()
            self._append_note(task, f"blocked: {reason}")
            return row, task

        return self.mutate("blocked", operation)

    def release(
        self,
        task_id: str,
        *,
        note: str = "",
        expected_owner: str,
        expected_lease_token: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        def operation(_session, _manifest, rows):
            row = self._row_by_id(rows, task_id)
            task = _task_value(row)
            self._require_active_lease(
                task,
                expected_owner=expected_owner,
                expected_lease_token=expected_lease_token,
                expected_revision=expected_revision,
            )
            previous_owner = str(task.get("owner") or "")
            task["status"] = "pending"
            task["revision"] = int(task.get("revision") or 0) + 1
            self._release_lease(task)
            task["released_from_owner"] = previous_owner
            task["owner"] = ""
            task["updated_at"] = now_iso()
            self._append_note(task, note or "claim released without task failure")
            return row, task

        return self.mutate("released", operation)

    def resume(
        self,
        task_id: str,
        *,
        note: str = "",
        reset_failure_budget: bool = False,
    ) -> dict[str, Any]:
        def operation(_session, _manifest, rows):
            row = self._row_by_id(rows, task_id)
            task = _task_value(row)
            if task.get("status") != "blocked":
                raise InvalidTaskStatusError(
                    f"只有 blocked 任务可以 resume: {task_id} -> {task.get('status')}"
                )
            if not self._deps_ready(rows, row):
                raise DependencyBlockedError(f"任务依赖未完成: {task_id}")
            task["status"] = "pending"
            task["revision"] = int(task.get("revision") or 0) + 1
            self._release_lease(task)
            task["blocked_reason"] = ""
            task["next_action"] = ""
            if reset_failure_budget:
                task["autodev_failure_count"] = 0
                task.pop("last_autodev_failure", None)
            task["updated_at"] = now_iso()
            resume_note = note or "resumed blocked task"
            if reset_failure_budget:
                resume_note = f"{resume_note} [failure budget reset by human]"
            self._append_note(task, resume_note)
            return row, task

        return self.mutate("resumed", operation)

    def propose(
        self,
        *,
        title: str,
        goal: str,
        acceptance: list[str],
        verify: list[str],
        source_refs: list[str],
        priority: str = "P2",
        area: str = "",
        proposed_by: str = "autodev",
        dependencies: list[str] | None = None,
    ) -> dict[str, Any]:
        if priority not in queue_yaml.PRIORITY_ORDER:
            raise ValueError(f"invalid priority: {priority}")
        refs = [str(item).strip() for item in source_refs if str(item).strip()]
        if not refs:
            raise ValueError("proposed task requires at least one source ref")
        if not str(goal or "").strip():
            raise ValueError("proposed task requires goal")
        with self.database.unit_of_work() as session:
            project, manifest, rows = self._locked_state(session)
            max_number = 0
            for row in rows:
                if row.task_id.startswith("H-"):
                    try:
                        max_number = max(max_number, int(row.task_id[2:]))
                    except ValueError:
                        pass
            task_id = f"H-{max_number + 1:03d}"
            task = {
                "id": task_id,
                "title": title,
                "status": "proposed",
                "priority": priority,
                "area": area,
                "goal": goal,
                "dependencies": dependencies or [],
                "acceptance": acceptance,
                "verify": verify,
                "source": {"proposed_by": proposed_by, "refs": refs},
                "artifacts": [],
                "notes": [
                    {"at": now_iso(), "text": "proposed; 未批准，不会自动开发"}
                ],
                "created_at": now_iso(),
                "updated_at": now_iso(),
            }
            queue_yaml._validate_queue(
                {
                    "schema_version": manifest.schema_version,
                    "policy": deepcopy(manifest.policy),
                    "tasks": [_task_value(row) for row in rows] + [task],
                }
            )
            spec, runtime = _split_task(task)
            row = QueueTask(
                project_id=project.id,
                task_id=task_id,
                origin="proposed",
                ordinal=max((item.ordinal for item in rows), default=-1) + 1,
                priority_rank=_priority_rank(task),
                spec=spec,
                spec_digest=canonical_digest(spec),
                runtime=runtime,
                status="proposed",
                revision=0,
                fencing_token=0,
            )
            session.add(row)
            session.flush()
            self._append_event(session, row, "proposed", task)
            return task

    def import_plan(
        self,
        payload: Any,
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        """Commit all imported tasks and their durable receipt together."""
        document = validate_import_request(payload)
        request_key = validate_idempotency_key(idempotency_key)
        source_uri = (
            f"issue-plan:{self.project.project_key}:{document['issue_plan_id']}"
        )
        with self.database.unit_of_work() as session:
            project, manifest, rows = self._locked_state(session)
            by_key = session.scalar(
                select(ImportBatch)
                .where(ImportBatch.idempotency_key == request_key)
                .with_for_update()
            )
            by_plan = session.scalars(
                select(ImportBatch)
                .where(
                    ImportBatch.source_kind == "issue_plan",
                    ImportBatch.source_uri == source_uri,
                )
                .order_by(ImportBatch.id)
                .with_for_update()
            ).first()
            for batch, identity in (
                (by_key, "idempotency key"),
                (by_plan, "Issue Plan identity"),
            ):
                if batch is None:
                    continue
                if (
                    batch.source_uri != source_uri
                    or batch.source_digest != document["plan_digest"]
                ):
                    raise QueueImportConflictError(
                        f"{identity} is already bound to a different Issue Plan"
                    )
                receipt = dict(batch.summary or {}).get("receipt")
                if batch.status != "completed":
                    raise QueueImportConflictError(
                        f"{identity} has an incomplete import record"
                    )
                validated = validate_stored_receipt(
                    receipt,
                    document,
                    [_task_value(row) for row in rows],
                )
                if batch is by_plan and by_key is None:
                    session.add(
                        ImportBatch(
                            idempotency_key=request_key,
                            source_kind="issue_plan_alias",
                            source_uri=source_uri,
                            source_digest=document["plan_digest"],
                            status="completed",
                            summary={
                                **dict(batch.summary or {}),
                                "receipt": deepcopy(validated),
                                "alias_of": batch.idempotency_key,
                            },
                        )
                    )
                return validated

            imported_rows = [
                row
                for row in rows
                if isinstance(row.spec.get("source"), dict)
                and row.spec["source"].get("issue_plan_id") == document["issue_plan_id"]
            ]
            if imported_rows:
                if any(
                    row.spec["source"].get("plan_digest") != document["plan_digest"]
                    for row in imported_rows
                ):
                    raise QueueImportConflictError(
                        "Issue Plan identity is already bound to a different digest"
                    )
                by_issue_key = {
                    str(row.spec["source"].get("issue_key") or ""): row.task_id
                    for row in imported_rows
                }
                expected_keys = [task["issue_key"] for task in document["tasks"]]
                if set(by_issue_key) != set(expected_keys) or len(imported_rows) != len(
                    expected_keys
                ):
                    raise QueueImportConflictError(
                        "existing Issue Plan projection is incomplete"
                    )
                receipt = {
                    "importId": import_id(document["issue_plan_id"], document["plan_digest"]),
                    "atomic": True,
                    "planDigest": document["plan_digest"],
                    "tasks": [
                        {"issueKey": key, "externalTaskId": by_issue_key[key]}
                        for key in expected_keys
                    ],
                }
                validate_stored_receipt(
                    receipt,
                    document,
                    [_task_value(row) for row in rows],
                )
                session.add(
                    ImportBatch(
                        idempotency_key=request_key,
                        source_kind="issue_plan",
                        source_uri=source_uri,
                        source_digest=document["plan_digest"],
                        status="completed",
                        summary={
                            "issue_plan_id": document["issue_plan_id"],
                            "task_count": len(imported_rows),
                            "receipt": deepcopy(receipt),
                            "recovered_from_queue": True,
                        },
                    )
                )
                return receipt

            imported_tasks, receipt = build_queue_tasks(
                document,
                [_task_value(row) for row in rows],
            )
            queue_yaml._validate_queue(
                {
                    "schema_version": manifest.schema_version,
                    "policy": deepcopy(manifest.policy),
                    "tasks": [_task_value(row) for row in rows] + imported_tasks,
                }
            )
            next_ordinal = max((row.ordinal for row in rows), default=-1) + 1
            for offset, task in enumerate(imported_tasks):
                spec, runtime = _split_task(task)
                row = QueueTask(
                    project_id=project.id,
                    task_id=str(task["id"]),
                    origin="issue_plan",
                    ordinal=next_ordinal + offset,
                    priority_rank=_priority_rank(task),
                    spec=spec,
                    spec_digest=canonical_digest(spec),
                    runtime=runtime,
                    status="pending",
                    revision=int(task.get("revision") or 0),
                    fencing_token=0,
                )
                session.add(row)
                session.flush()
                self._append_event(session, row, "issue_plan_imported", task)
            session.add(
                ImportBatch(
                    idempotency_key=request_key,
                    source_kind="issue_plan",
                    source_uri=source_uri,
                    source_digest=document["plan_digest"],
                    status="completed",
                    summary={
                        "issue_plan_id": document["issue_plan_id"],
                        "task_count": len(imported_tasks),
                        "receipt": deepcopy(receipt),
                    },
                )
            )
            return receipt

    def approve(
        self, task_id: str, *, approver: str = "human", note: str = ""
    ) -> dict[str, Any]:
        def operation(_session, _manifest, rows):
            row = self._row_by_id(rows, task_id)
            task = _task_value(row)
            if task.get("status") != "proposed":
                raise InvalidTaskStatusError(
                    f"只有 proposed 任务可以 approve: {task_id} -> {task.get('status')}"
                )
            task["status"] = "pending"
            task["revision"] = int(task.get("revision") or 0) + 1
            task["approved_by"] = approver
            task["approved_at"] = now_iso()
            task["updated_at"] = now_iso()
            self._append_note(task, note or f"approved by {approver}")
            return row, task

        return self.mutate("approved", operation)

    def events(self, task_id: str) -> list[dict[str, Any]]:
        with self.database.unit_of_work() as session:
            _, _, rows = self._read_state(session)
            row = self._row_by_id(rows, task_id)
            events = session.scalars(
                select(QueueTaskEvent)
                .where(QueueTaskEvent.task_pk == row.id)
                .order_by(QueueTaskEvent.seq)
            ).all()
            return [deepcopy(event.payload) for event in events]


class DatabaseQueuePort:
    """QueuePort facade that preserves the YAML adapter's result semantics."""

    def __init__(self, repository: DatabaseQueueRepository) -> None:
        self.repository = repository

    def summary(self) -> QueueOperationResult:
        try:
            return QueueOperationResult(
                ok=True, status="ok", summary=self.repository.summary()
            )
        except Exception as exc:
            return _error_result(exc)

    def dashboard_snapshot(
        self,
    ) -> tuple[QueueOperationResult, list[dict[str, Any]]]:
        try:
            summary, tasks = self.repository.dashboard_snapshot()
            return (
                QueueOperationResult(ok=True, status="ok", summary=summary),
                [_task_snapshot(task) for task in tasks],
            )
        except Exception as exc:
            return _error_result(exc), []

    def next(self) -> QueueOperationResult:
        try:
            candidates = self.repository.ready_candidates(1)
            if not candidates:
                return QueueOperationResult(
                    ok=False,
                    status="no_ready_task",
                    message="没有可领取的 pending 任务",
                )
            return QueueOperationResult(
                ok=True, status="ok", task=_task_snapshot(candidates[0])
            )
        except Exception as exc:
            return _error_result(exc)

    def ready_candidates(self, limit: int) -> list[dict[str, Any]]:
        return [
            _task_snapshot(task)
            for task in self.repository.ready_candidates(limit)
        ]

    def get_task(self, task_id: str) -> dict[str, Any]:
        return _task_snapshot(self.repository.get_task(task_id))

    def list_tasks(self) -> list[dict[str, Any]]:
        return [_task_snapshot(task) for task in self.repository.list_tasks()]

    def _result(self, operation: Callable[[], dict[str, Any]]) -> QueueOperationResult:
        try:
            return QueueOperationResult(
                ok=True, status="ok", task=_task_snapshot(operation())
            )
        except Exception as exc:
            return _error_result(exc)

    def claim(
        self,
        task_id: str = "",
        *,
        owner: str = "autodev",
        note: str = "",
        lease_token: str = "",
    ) -> QueueOperationResult:
        return self._result(
            lambda: self.repository.claim(
                task_id, owner=owner, note=note, lease_token=lease_token
            )
        )

    def done(self, task_id: str, **kwargs: Any) -> QueueOperationResult:
        return self._result(lambda: self.repository.done(task_id, **kwargs))

    def block(self, task_id: str, **kwargs: Any) -> QueueOperationResult:
        return self._result(lambda: self.repository.block(task_id, **kwargs))

    def release(
        self,
        task_id: str,
        *,
        note: str = "",
        expected_owner: str = "",
        expected_lease_token: str = "",
        expected_revision: int | None = None,
    ) -> QueueOperationResult:
        if expected_revision is None:
            return _error_result(
                LeaseConflictError(
                    "owner, lease token, and revision are required to release task"
                )
            )
        return self._result(
            lambda: self.repository.release(
                task_id,
                note=note,
                expected_owner=expected_owner,
                expected_lease_token=expected_lease_token,
                expected_revision=expected_revision,
            )
        )

    def resume(self, task_id: str, **kwargs: Any) -> QueueOperationResult:
        return self._result(lambda: self.repository.resume(task_id, **kwargs))

    def propose(self, **kwargs: Any) -> QueueOperationResult:
        return self._result(lambda: self.repository.propose(**kwargs))

    def approve(
        self, task_id: str, *, approver: str = "human", note: str = ""
    ) -> QueueOperationResult:
        return self._result(
            lambda: self.repository.approve(task_id, approver=approver, note=note)
        )

    def import_plan(
        self,
        payload: Any,
        *,
        idempotency_key: str,
    ) -> QueueImportResult:
        try:
            receipt = self.repository.import_plan(
                payload,
                idempotency_key=idempotency_key,
            )
            return QueueImportResult(ok=True, status="ok", receipt=receipt)
        except Exception as exc:
            return _import_error_result(exc)
