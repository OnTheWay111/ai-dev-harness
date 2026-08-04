"""Queue adapter layer for AutoDev harness controllers."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from autodev.config import AutoDevConfig, QueueConfig
from autodev.adapters import queue_yaml as task_harness
from autodev.adapters.queue_yaml import (
    DependencyBlockedError,
    InProgressExistsError,
    InvalidQueueError,
    InvalidTaskStatusError,
    LeaseConflictError,
    NoReadyTaskError,
    TaskNotFoundError,
)
from autodev.queue_import import QueueImportConflictError, QueueImportValidationError


SUPPORTED_QUEUE_TYPE = "task_harness_yaml"


class QueueAdapterError(ValueError):
    """Raised when a queue adapter cannot be constructed."""


@dataclass(frozen=True)
class QueueOperationResult:
    ok: bool
    status: str
    message: str = ""
    task: dict[str, Any] | None = None
    summary: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "message": self.message,
            "task": deepcopy(self.task),
            "summary": deepcopy(self.summary),
        }


@dataclass(frozen=True)
class QueueImportResult:
    ok: bool
    status: str
    message: str = ""
    receipt: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "message": self.message,
            "receipt": deepcopy(self.receipt),
        }


class QueuePort(Protocol):
    """Queue operations required by AutoDev core orchestration.

    Implementations own persistence and queue-schema details. Core callers only
    depend on this contract so a different queue backend can be supplied at
    the composition root.
    """

    def summary(self) -> QueueOperationResult: ...

    def next(self) -> QueueOperationResult: ...

    def ready_candidates(self, limit: int) -> list[dict[str, Any]]: ...

    def get_task(self, task_id: str) -> dict[str, Any]: ...

    def list_tasks(self) -> list[dict[str, Any]]: ...

    def claim(
        self,
        task_id: str = "",
        *,
        owner: str = "autodev",
        note: str = "",
        lease_token: str = "",
    ) -> QueueOperationResult: ...

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
    ) -> QueueOperationResult: ...

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
    ) -> QueueOperationResult: ...

    def release(
        self,
        task_id: str,
        *,
        note: str = "",
        expected_owner: str = "",
        expected_lease_token: str = "",
        expected_revision: int | None = None,
    ) -> QueueOperationResult: ...

    def resume(
        self,
        task_id: str,
        *,
        note: str = "",
        reset_failure_budget: bool = False,
    ) -> QueueOperationResult: ...

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
    ) -> QueueOperationResult: ...

    def approve(self, task_id: str, *, approver: str = "human", note: str = "") -> QueueOperationResult: ...

    def import_plan(
        self,
        payload: Any,
        *,
        idempotency_key: str,
    ) -> QueueImportResult: ...


def _task_snapshot(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(task.get("id") or ""),
        "title": str(task.get("title") or ""),
        "status": str(task.get("status") or "pending"),
        "priority": str(task.get("priority") or "P2"),
        "area": str(task.get("area") or ""),
        "goal": str(task.get("goal") or ""),
        "preferred_builder": str(task.get("preferred_builder") or ""),
        "dependencies": list(task.get("dependencies") or []),
        "exclusive_resources": list(task.get("exclusive_resources") or []),
        "acceptance": list(task.get("acceptance") or []),
        "verify": list(task.get("verify") or []),
        "source": deepcopy(task.get("source") or {}),
        "artifacts": list(task.get("artifacts") or []),
        "notes": deepcopy(task.get("notes") or []),
        "blocked_reason": str(task.get("blocked_reason") or ""),
        "next_action": str(task.get("next_action") or ""),
        "owner": str(task.get("owner") or ""),
        "lease_token": str(task.get("lease_token") or ""),
        "revision": int(task.get("revision") or 0),
        "raw": deepcopy(task),
    }


def _error_result(exc: Exception) -> QueueOperationResult:
    message = str(exc)
    if isinstance(exc, FileNotFoundError):
        status = "queue_not_found"
    elif isinstance(exc, InProgressExistsError):
        status = "in_progress_exists"
    elif isinstance(exc, NoReadyTaskError):
        status = "no_ready_task"
    elif isinstance(exc, DependencyBlockedError):
        status = "dependency_blocked"
    elif isinstance(exc, TaskNotFoundError):
        status = "task_not_found"
    elif isinstance(exc, InvalidTaskStatusError):
        status = "invalid_status"
    elif isinstance(exc, LeaseConflictError):
        status = "lease_conflict"
    elif isinstance(exc, InvalidQueueError):
        status = "invalid_queue"
    else:
        status = "error"
    return QueueOperationResult(ok=False, status=status, message=message)


def _import_error_result(exc: Exception) -> QueueImportResult:
    if isinstance(exc, QueueImportConflictError):
        status = "idempotency_conflict"
    elif isinstance(exc, QueueImportValidationError):
        status = "invalid_import"
    elif isinstance(exc, (InvalidQueueError, FileNotFoundError)):
        status = "queue_unavailable"
    else:
        status = "error"
    return QueueImportResult(ok=False, status=status, message=str(exc))


class TaskHarnessQueueAdapter:
    """Thin adapter over the extracted v1 YAML queue implementation.

    It intentionally delegates all queue reads and writes to task_harness so the
    file lock and atomic write behavior stay in one place.
    """

    def __init__(self, queue_path: str | Path, *, queue_type: str = SUPPORTED_QUEUE_TYPE):
        if queue_type != SUPPORTED_QUEUE_TYPE:
            raise QueueAdapterError(f"unsupported queue type: {queue_type}")
        self.queue_path = Path(queue_path)

    @classmethod
    def from_config(cls, config: AutoDevConfig | QueueConfig) -> "TaskHarnessQueueAdapter":
        queue = config.queue if isinstance(config, AutoDevConfig) else config
        return cls(queue.path, queue_type=queue.type)

    def summary(self) -> QueueOperationResult:
        try:
            summary = task_harness.queue_summary(task_harness.load_queue(self.queue_path))
            return QueueOperationResult(ok=True, status="ok", summary=summary)
        except Exception as exc:
            return _error_result(exc)

    def dashboard_snapshot(self) -> tuple[QueueOperationResult, list[dict[str, Any]]]:
        """Load dashboard queue summary and task rows from one YAML snapshot."""
        try:
            queue = task_harness.load_queue(self.queue_path)
            result = QueueOperationResult(
                ok=True,
                status="ok",
                summary=task_harness.queue_summary(queue),
            )
            tasks = [_task_snapshot(task) for task in queue.get("tasks", [])]
            return result, tasks
        except Exception as exc:
            return _error_result(exc), []

    def get_task(self, task_id: str) -> dict[str, Any]:
        """Return one task snapshot or preserve the queue module's typed error."""
        return _task_snapshot(task_harness.get_task(self.queue_path, task_id))

    def list_tasks(self) -> list[dict[str, Any]]:
        """Return read-only task snapshots for dashboard and handoff consumers."""
        queue = task_harness.load_queue(self.queue_path)
        return [_task_snapshot(task) for task in queue.get("tasks", [])]

    def next(self) -> QueueOperationResult:
        try:
            task = task_harness.next_task(task_harness.load_queue(self.queue_path))
            if not task:
                return QueueOperationResult(ok=False, status="no_ready_task", message="没有可领取的 pending 任务")
            return QueueOperationResult(ok=True, status="ok", task=_task_snapshot(task))
        except Exception as exc:
            return _error_result(exc)

    def ready_candidates(self, limit: int) -> list[dict[str, Any]]:
        return [
            _task_snapshot(task)
            for task in task_harness.ready_task_candidates(self.queue_path, limit=limit)
        ]

    def claim(
        self,
        task_id: str = "",
        *,
        owner: str = "autodev",
        note: str = "",
        lease_token: str = "",
    ) -> QueueOperationResult:
        try:
            task = task_harness.claim_task(
                self.queue_path,
                task_id=task_id,
                owner=owner,
                note=note,
                lease_token=lease_token,
            )
            return QueueOperationResult(ok=True, status="ok", task=_task_snapshot(task))
        except Exception as exc:
            return _error_result(exc)

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
    ) -> QueueOperationResult:
        try:
            task = task_harness.complete_task(
                self.queue_path,
                task_id=task_id,
                note=note,
                artifacts=artifacts or [],
                expected_owner=expected_owner,
                expected_lease_token=expected_lease_token,
                expected_revision=expected_revision,
                force_reconcile=force_reconcile,
                review_passed=review_passed,
            )
            return QueueOperationResult(ok=True, status="ok", task=_task_snapshot(task))
        except Exception as exc:
            return _error_result(exc)

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
    ) -> QueueOperationResult:
        try:
            task = task_harness.block_task(
                self.queue_path,
                task_id=task_id,
                reason=reason,
                next_action=next_action,
                expected_owner=expected_owner,
                expected_lease_token=expected_lease_token,
                expected_revision=expected_revision,
                force_reconcile=force_reconcile,
                failure_status=failure_status,
                failure_run_id=failure_run_id,
            )
            return QueueOperationResult(ok=True, status="ok", task=_task_snapshot(task))
        except Exception as exc:
            return _error_result(exc)

    def release(
        self,
        task_id: str,
        *,
        note: str = "",
        expected_owner: str = "",
        expected_lease_token: str = "",
        expected_revision: int | None = None,
    ) -> QueueOperationResult:
        try:
            if expected_revision is None:
                raise LeaseConflictError(
                    "owner, lease token, and revision are required to release task"
                )
            task = task_harness.release_task(
                self.queue_path,
                task_id=task_id,
                note=note,
                expected_owner=expected_owner,
                expected_lease_token=expected_lease_token,
                expected_revision=expected_revision,
            )
            return QueueOperationResult(ok=True, status="ok", task=_task_snapshot(task))
        except Exception as exc:
            return _error_result(exc)

    def resume(
        self,
        task_id: str,
        *,
        note: str = "",
        reset_failure_budget: bool = False,
    ) -> QueueOperationResult:
        try:
            task = task_harness.resume_task(
                self.queue_path,
                task_id=task_id,
                note=note,
                reset_failure_budget=reset_failure_budget,
            )
            return QueueOperationResult(ok=True, status="ok", task=_task_snapshot(task))
        except Exception as exc:
            return _error_result(exc)

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
    ) -> QueueOperationResult:
        try:
            task = task_harness.propose_task(
                self.queue_path,
                title=title,
                goal=goal,
                acceptance=acceptance,
                verify=verify,
                source_refs=source_refs,
                priority=priority,
                area=area,
                proposed_by=proposed_by,
                dependencies=dependencies or [],
            )
            return QueueOperationResult(ok=True, status="ok", task=_task_snapshot(task))
        except Exception as exc:
            return _error_result(exc)

    def approve(self, task_id: str, *, approver: str = "human", note: str = "") -> QueueOperationResult:
        try:
            task = task_harness.approve_task(
                self.queue_path,
                task_id=task_id,
                approver=approver,
                note=note,
            )
            return QueueOperationResult(ok=True, status="ok", task=_task_snapshot(task))
        except Exception as exc:
            return _error_result(exc)

    def import_plan(
        self,
        payload: Any,
        *,
        idempotency_key: str,
    ) -> QueueImportResult:
        try:
            receipt = task_harness.import_plan(
                self.queue_path,
                payload,
                idempotency_key=idempotency_key,
            )
            return QueueImportResult(ok=True, status="ok", receipt=receipt)
        except Exception as exc:
            return _import_error_result(exc)


def create_queue_port(config: AutoDevConfig | QueueConfig) -> QueuePort:
    """Build the configured queue port at an application's composition root."""
    from autodev.database.config import MODE_DATABASE
    from autodev.database.shadow import resolve_persistence_config

    persistence = resolve_persistence_config()
    if persistence.mode == MODE_DATABASE:
        if not isinstance(config, AutoDevConfig):
            raise QueueAdapterError(
                "database queue composition requires the full AutoDevConfig"
            )
        from autodev.database.composition import queue_port_for_config

        return queue_port_for_config(config, database_config=persistence)
    return TaskHarnessQueueAdapter.from_config(config)
