"""Transactional landing ledger and Git-ref recovery decisions."""
from __future__ import annotations

from copy import deepcopy
import re
from typing import Any, Mapping

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from autodev.persistence import (
    PersistenceConflictError,
    PersistenceNotFoundError,
)

from .engine import Database
from .models import Landing, Project
from .run_repository import ProjectIdentity


LANDING_STATES = ("prepared", "integrated", "queue_finalized")
_STATE_INDEX = {state: index for index, state in enumerate(LANDING_STATES)}
_GIT_SHA = re.compile(r"^[0-9a-fA-F]{40,64}$")


def _required_text(record: Mapping[str, Any], key: str) -> str:
    value = str(record.get(key) or "").strip()
    if not value:
        raise ValueError(f"landing {key} is required")
    return value


def _validate_git_sha(value: str, label: str) -> str:
    if not _GIT_SHA.fullmatch(value):
        raise ValueError(f"landing {label} must be a full Git object id")
    return value.lower()


def _landing_value(row: Landing, project_key: str) -> dict[str, Any]:
    return {
        "project_id": project_key,
        "project_pk": row.project_id,
        "task_id": row.task_id,
        "run_id": row.run_id,
        "integration_branch": row.integration_branch,
        "expected_ref": row.expected_ref,
        "candidate_sha": row.candidate_sha,
        "queue_claim": deepcopy(row.queue_claim),
        "push_required": bool(row.push_required),
        "pushed": bool(row.pushed),
        "state": row.state,
        "version": row.version,
        "detail": deepcopy(row.detail) if row.detail is not None else {},
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


class DatabaseLandingStore:
    """Project-scoped recovery ledger for the Git/Queue external transaction."""

    def __init__(self, database: Database, project: ProjectIdentity) -> None:
        self.database = database
        self.project = project

    def _project_row(self, session: Session, *, lock: bool) -> Project:
        statement = select(Project).where(
            Project.project_key == self.project.project_key
        )
        row = session.scalar(statement.with_for_update() if lock else statement)
        if row is None:
            try:
                with session.begin_nested():
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
            except IntegrityError:
                row = session.scalar(
                    statement.with_for_update() if lock else statement
                )
                if row is None:
                    raise PersistenceConflictError(
                        "project initialization conflict: "
                        f"{self.project.project_key!r}"
                    )
        if (row.repo_root, row.repo_fingerprint) != (
            self.project.repo_root,
            self.project.repo_fingerprint,
        ):
            raise PersistenceConflictError(
                f"project identity conflict for {self.project.project_key!r}"
            )
        return row

    @staticmethod
    def _query(
        project_pk: int,
        task_id: str,
        run_id: str,
        *,
        lock: bool,
    ):
        statement = select(Landing).where(
            Landing.project_id == project_pk,
            Landing.task_id == task_id,
            Landing.run_id == run_id,
        )
        return statement.with_for_update() if lock else statement

    def _locked(
        self,
        session: Session,
        project_pk: int,
        task_id: str,
        run_id: str,
    ) -> Landing:
        row = session.scalar(
            self._query(project_pk, task_id, run_id, lock=True)
        )
        if row is None:
            raise PersistenceNotFoundError(
                f"landing not found: {task_id}/{run_id}"
            )
        return row

    @staticmethod
    def _identity(record: Mapping[str, Any]) -> tuple[Any, ...]:
        return (
            str(record.get("task_id") or ""),
            str(record.get("run_id") or ""),
            str(record.get("integration_branch") or ""),
            str(record.get("expected_ref") or "").lower(),
            str(record.get("candidate_sha") or "").lower(),
            deepcopy(dict(record.get("queue_claim") or {})),
            bool(record.get("push_required")),
        )

    def prepare(self, record: Mapping[str, Any]) -> Mapping[str, Any]:
        value = deepcopy(dict(record))
        task_id = _required_text(value, "task_id")
        run_id = _required_text(value, "run_id")
        branch = _required_text(value, "integration_branch")
        expected_ref = _validate_git_sha(
            _required_text(value, "expected_ref"), "expected_ref"
        )
        candidate_sha = _validate_git_sha(
            _required_text(value, "candidate_sha"), "candidate_sha"
        )
        claim = value.get("queue_claim")
        if not isinstance(claim, Mapping):
            raise ValueError("landing queue_claim must be a mapping")
        with self.database.unit_of_work() as session:
            project = self._project_row(session, lock=True)
            row = session.scalar(
                self._query(project.id, task_id, run_id, lock=True)
            )
            if row is not None:
                if self._identity(
                    _landing_value(row, self.project.project_key)
                ) != self._identity(value):
                    raise PersistenceConflictError(
                        f"landing identity conflict: {task_id}/{run_id}"
                    )
                # pushed/detail are mutable recovery evidence, not immutable
                # prepare identity. An idempotent retry returns stored truth.
                return _landing_value(row, self.project.project_key)
            row = Landing(
                project_id=project.id,
                task_id=task_id,
                run_id=run_id,
                integration_branch=branch,
                expected_ref=expected_ref,
                candidate_sha=candidate_sha,
                queue_claim=deepcopy(dict(claim)),
                push_required=bool(value.get("push_required")),
                pushed=bool(value.get("pushed")),
                state="prepared",
                version=1,
                detail=deepcopy(dict(value.get("detail") or {})),
            )
            session.add(row)
            session.flush()
            return _landing_value(row, self.project.project_key)

    def get(self, task_id: str, run_id: str) -> Mapping[str, Any]:
        with self.database.unit_of_work() as session:
            project = self._project_row(session, lock=False)
            row = session.scalar(
                self._query(project.id, task_id, run_id, lock=False)
            )
            if row is None:
                raise PersistenceNotFoundError(
                    f"landing not found: {task_id}/{run_id}"
                )
            return _landing_value(row, self.project.project_key)

    def replace_prepared(
        self,
        record: Mapping[str, Any],
        *,
        current_ref: str,
        previous_candidate_is_ancestor: bool,
    ) -> Mapping[str, Any]:
        """Replace a losing prepared CAS after Git proves it never landed."""
        value = deepcopy(dict(record))
        task_id = _required_text(value, "task_id")
        run_id = _required_text(value, "run_id")
        branch = _required_text(value, "integration_branch")
        expected_ref = _validate_git_sha(
            _required_text(value, "expected_ref"), "expected_ref"
        )
        candidate_sha = _validate_git_sha(
            _required_text(value, "candidate_sha"), "candidate_sha"
        )
        current = _validate_git_sha(current_ref, "current_ref")
        if current != expected_ref:
            raise PersistenceConflictError(
                "replacement expected_ref does not match current Git truth"
            )
        if previous_candidate_is_ancestor:
            raise PersistenceConflictError(
                "cannot replace a prepared landing whose candidate is integrated"
            )
        claim = value.get("queue_claim")
        if not isinstance(claim, Mapping):
            raise ValueError("landing queue_claim must be a mapping")
        with self.database.unit_of_work() as session:
            project = self._project_row(session, lock=True)
            row = self._locked(session, project.id, task_id, run_id)
            if row.state != "prepared":
                raise PersistenceConflictError(
                    f"landing is no longer prepared: {row.state}"
                )
            if current == row.expected_ref:
                raise PersistenceConflictError(
                    "prepared landing still matches current Git ref"
                )
            immutable_existing = (
                row.task_id,
                row.run_id,
                row.integration_branch,
                deepcopy(row.queue_claim),
                bool(row.push_required),
            )
            immutable_replacement = (
                task_id,
                run_id,
                branch,
                deepcopy(dict(claim)),
                bool(value.get("push_required")),
            )
            if immutable_existing != immutable_replacement:
                raise PersistenceConflictError(
                    f"landing replacement identity conflict: {task_id}/{run_id}"
                )
            row.expected_ref = expected_ref
            row.candidate_sha = candidate_sha
            row.pushed = bool(value.get("pushed"))
            row.detail = deepcopy(dict(value.get("detail") or {}))
            row.version += 1
            session.flush()
            return _landing_value(row, self.project.project_key)

    def advance(
        self,
        project_id: str,
        task_id: str,
        run_id: str,
        *,
        expected_status: str,
        new_status: str,
        changes: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        if project_id != self.project.project_key:
            raise PersistenceConflictError(
                f"landing project mismatch: {project_id!r}"
            )
        if expected_status not in _STATE_INDEX or new_status not in _STATE_INDEX:
            raise ValueError("unknown landing state")
        if _STATE_INDEX[new_status] != _STATE_INDEX[expected_status] + 1:
            raise ValueError(
                f"invalid landing transition: {expected_status} -> {new_status}"
            )
        updates = deepcopy(dict(changes or {}))
        unknown = set(updates) - {"pushed", "detail"}
        if unknown:
            raise ValueError(f"unsupported landing changes: {sorted(unknown)}")
        with self.database.unit_of_work() as session:
            project = self._project_row(session, lock=True)
            row = self._locked(session, project.id, task_id, run_id)
            if row.state != expected_status:
                raise PersistenceConflictError(
                    "landing state conflict: "
                    f"expected {expected_status}, found {row.state}"
                )
            row.state = new_status
            row.version += 1
            if "pushed" in updates:
                row.pushed = bool(updates["pushed"])
            if "detail" in updates:
                detail = updates["detail"]
                if not isinstance(detail, Mapping):
                    raise ValueError("landing detail must be a mapping")
                row.detail = deepcopy(dict(detail))
            session.flush()
            return _landing_value(row, self.project.project_key)

    def update_evidence(
        self,
        project_id: str,
        task_id: str,
        run_id: str,
        *,
        expected_status: str,
        changes: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        """Update recovery evidence without weakening the state machine."""
        if project_id != self.project.project_key:
            raise PersistenceConflictError(
                f"landing project mismatch: {project_id!r}"
            )
        if expected_status not in _STATE_INDEX:
            raise ValueError("unknown landing state")
        updates = deepcopy(dict(changes))
        unknown = set(updates) - {"pushed", "detail"}
        if unknown:
            raise ValueError(f"unsupported landing changes: {sorted(unknown)}")
        with self.database.unit_of_work() as session:
            project = self._project_row(session, lock=True)
            row = self._locked(session, project.id, task_id, run_id)
            if row.state != expected_status:
                raise PersistenceConflictError(
                    "landing state conflict: "
                    f"expected {expected_status}, found {row.state}"
                )
            if "pushed" in updates:
                row.pushed = bool(updates["pushed"])
            if "detail" in updates:
                detail = updates["detail"]
                if not isinstance(detail, Mapping):
                    raise ValueError("landing detail must be a mapping")
                row.detail = deepcopy(dict(detail))
            row.version += 1
            session.flush()
            return _landing_value(row, self.project.project_key)

    def pending(self, project_id: str) -> list[Mapping[str, Any]]:
        if project_id != self.project.project_key:
            raise PersistenceConflictError(
                f"landing project mismatch: {project_id!r}"
            )
        with self.database.unit_of_work() as session:
            project = self._project_row(session, lock=False)
            rows = session.scalars(
                select(Landing)
                .where(
                    Landing.project_id == project.id,
                    Landing.state.not_in(
                        ("queue_finalized", "abandoned")
                    ),
                )
                .order_by(Landing.updated_at, Landing.id)
            ).all()
            return [
                _landing_value(row, self.project.project_key) for row in rows
            ]

    def reconcile_git_fact(
        self,
        task_id: str,
        run_id: str,
        *,
        current_ref: str,
        candidate_is_ancestor: bool,
    ) -> Mapping[str, Any]:
        """Classify a crash using Git as truth and persist proven integration.

        ``resume_prepared`` means Git is still at the expected pre-CAS ref, so
        the normal serialized landing path must rerun. ``finalize_queue`` means
        Git already contains the reviewed candidate and Queue finalization is
        the only safe next write.
        """
        current = _validate_git_sha(current_ref, "current_ref")
        with self.database.unit_of_work() as session:
            project = self._project_row(session, lock=True)
            row = self._locked(session, project.id, task_id, run_id)
            if row.state == "queue_finalized":
                return {
                    **_landing_value(row, self.project.project_key),
                    "recovery_action": "none",
                }
            if row.state == "prepared" and current == row.expected_ref:
                return {
                    **_landing_value(row, self.project.project_key),
                    "recovery_action": "resume_prepared",
                }
            if not candidate_is_ancestor and row.state == "prepared":
                return {
                    **_landing_value(row, self.project.project_key),
                    "recovery_action": "retry_prepared",
                }
            if not candidate_is_ancestor:
                raise PersistenceConflictError(
                    "integration ref is neither the expected pre-CAS ref "
                    "nor a ref containing the candidate"
                )
            if row.state == "prepared":
                row.state = "integrated"
                row.version += 1
                session.flush()
            return {
                **_landing_value(row, self.project.project_key),
                "recovery_action": "finalize_queue",
            }

    def abandon_prepared(
        self,
        task_id: str,
        run_id: str,
        *,
        current_ref: str,
        candidate_is_ancestor: bool,
    ) -> Mapping[str, Any]:
        """Retire a losing CAS once Git and Queue prove it cannot resume."""
        current = _validate_git_sha(current_ref, "current_ref")
        if candidate_is_ancestor:
            raise PersistenceConflictError(
                "cannot abandon a landing whose candidate is integrated"
            )
        with self.database.unit_of_work() as session:
            project = self._project_row(session, lock=True)
            row = self._locked(session, project.id, task_id, run_id)
            if row.state != "prepared":
                raise PersistenceConflictError(
                    f"landing is no longer prepared: {row.state}"
                )
            if current == row.expected_ref:
                raise PersistenceConflictError(
                    "prepared landing still matches current Git ref"
                )
            row.state = "abandoned"
            row.detail = {
                **deepcopy(row.detail or {}),
                "abandoned_current_ref": current,
                "reason": "integration CAS lost before candidate landed",
            }
            row.version += 1
            session.flush()
            return _landing_value(row, self.project.project_key)


class DatabaseLandingStorePort:
    def __init__(self, repository: DatabaseLandingStore) -> None:
        self.repository = repository

    def prepare(self, record: Mapping[str, Any]) -> Mapping[str, Any]:
        return self.repository.prepare(record)

    def advance(
        self,
        project_id: str,
        task_id: str,
        run_id: str,
        *,
        expected_status: str,
        new_status: str,
        changes: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        return self.repository.advance(
            project_id,
            task_id,
            run_id,
            expected_status=expected_status,
            new_status=new_status,
            changes=changes,
        )

    def pending(self, project_id: str) -> list[Mapping[str, Any]]:
        return self.repository.pending(project_id)

    def update_evidence(
        self,
        project_id: str,
        task_id: str,
        run_id: str,
        *,
        expected_status: str,
        changes: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        return self.repository.update_evidence(
            project_id,
            task_id,
            run_id,
            expected_status=expected_status,
            changes=changes,
        )
