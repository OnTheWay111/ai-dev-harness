"""Version-1 YAML task queue adapter.

This module owns the AutoDev YAML queue behavior. It intentionally has no
dependency on the legacy source-project runtime package.
"""
from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from pathlib import Path
import secrets
from typing import Any, TypeVar

import yaml

from autodev._internal.io import atomic_write_yaml, file_lock
from autodev._internal.schema import ensure_schema_v1
from autodev._internal.time import now_iso
from autodev.run_store import validate_task_id


VALID_STATUSES = {"pending", "proposed", "in_progress", "blocked", "done", "skipped"}
TERMINAL_STATUSES = {"done", "skipped"}
PRIORITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
INDEPENDENT_REVIEW_GATE = "independent_review"
REVIEW_GATED_FAILURE_STATUSES = {
    "review_red",
    "review_blocked",
    "safety_policy_red",
    "queue_contract_red",
    "landing_review_red",
    "landing_safety_policy_red",
}
T = TypeVar("T")


class TaskHarnessError(RuntimeError):
    """Base error for queue state-machine operations."""


class NoReadyTaskError(TaskHarnessError):
    """Raised when no dependency-ready pending task exists."""


class InProgressExistsError(TaskHarnessError):
    """Raised when a claim would exceed the configured concurrency limit."""


class DependencyBlockedError(TaskHarnessError):
    """Raised when a task's dependencies are not terminal."""


class TaskNotFoundError(TaskHarnessError):
    """Raised when an operation names an unknown task."""


class InvalidTaskStatusError(TaskHarnessError):
    """Raised when a state transition is invalid."""


class InvalidQueueError(ValueError):
    """Raised when the queue YAML does not meet the v1 contract."""


class LeaseConflictError(TaskHarnessError):
    """Raised when a stale or unauthenticated worker tries to mutate a claim."""


def _queue_path(path: str | Path) -> Path:
    return Path(path).expanduser()


def _read_queue_unlocked(queue_path: Path) -> dict[str, Any]:
    if not queue_path.exists():
        raise FileNotFoundError(f"task queue not found: {queue_path}")
    loaded = yaml.safe_load(queue_path.read_text(encoding="utf-8")) or {}
    if not isinstance(loaded, dict):
        raise InvalidQueueError("queue root must be a mapping")
    ensure_schema_v1(loaded, label="task queue", error_type=InvalidQueueError)
    loaded.setdefault("policy", {})
    loaded.setdefault("tasks", [])
    _validate_queue(loaded)
    return loaded


def load_queue(path: str | Path) -> dict[str, Any]:
    return _read_queue_unlocked(_queue_path(path))


def _write_queue_unlocked(queue: dict[str, Any], queue_path: Path) -> None:
    queue_path.parent.mkdir(parents=True, exist_ok=True)
    queue["updated_at"] = now_iso()
    _validate_queue(queue)
    atomic_write_yaml(queue_path, queue)


def save_queue(queue: dict[str, Any], path: str | Path) -> None:
    queue_path = _queue_path(path)
    with file_lock(queue_path):
        _write_queue_unlocked(queue, queue_path)


def import_plan(
    path: str | Path,
    payload: Any,
    *,
    idempotency_key: str,
) -> dict[str, Any]:
    """Atomically append every task in one approved Issue Plan.

    The receipt is persisted in the same replacement write as the tasks. A
    replay by idempotency key or by plan identity returns the original receipt
    without rewriting the queue file.
    """
    from autodev.queue_import import (
        QueueImportConflictError,
        build_queue_tasks,
        validate_idempotency_key,
        validate_import_request,
        validate_stored_receipt,
    )

    document = validate_import_request(payload)
    request_key = validate_idempotency_key(idempotency_key)
    queue_path = _queue_path(path)
    with file_lock(queue_path):
        queue = _read_queue_unlocked(queue_path)
        imports = queue.get("imports", [])
        if not isinstance(imports, list):
            raise InvalidQueueError("imports must be a list")
        for record_index, record in enumerate(imports):
            if not isinstance(record, dict):
                raise InvalidQueueError("each import receipt must be a mapping")
            stored_keys = record.get("idempotency_keys")
            if stored_keys is None and record.get("idempotency_key"):
                stored_keys = [record["idempotency_key"]]
            if not isinstance(stored_keys, list) or not all(
                isinstance(item, str) and item for item in stored_keys
            ):
                raise InvalidQueueError("import idempotency_keys must be a string list")
            if len(set(stored_keys)) != len(stored_keys):
                raise InvalidQueueError("import idempotency_keys must not contain duplicates")
            same_key = request_key in stored_keys
            same_plan_id = record.get("issue_plan_id") == document["issue_plan_id"]
            same_digest = record.get("plan_digest") == document["plan_digest"]
            if same_key and not (same_plan_id and same_digest):
                raise QueueImportConflictError(
                    "idempotency key is already bound to a different Issue Plan"
                )
            if same_plan_id and not same_digest:
                raise QueueImportConflictError(
                    "Issue Plan identity is already bound to a different digest"
                )
            if (same_key or same_plan_id) and same_digest:
                receipt = validate_stored_receipt(
                    record.get("receipt"),
                    document,
                    queue.get("tasks", []),
                )
                if not same_key:
                    candidate = deepcopy(queue)
                    candidate_record = candidate["imports"][record_index]
                    candidate_record.pop("idempotency_key", None)
                    candidate_record["idempotency_keys"] = [*stored_keys, request_key]
                    _write_queue_unlocked(candidate, queue_path)
                return receipt

        imported_tasks, receipt = build_queue_tasks(document, queue.get("tasks", []))
        candidate = deepcopy(queue)
        candidate.setdefault("tasks", []).extend(imported_tasks)
        candidate.setdefault("imports", []).append(
            {
                "idempotency_keys": [request_key],
                "issue_plan_id": document["issue_plan_id"],
                "plan_digest": document["plan_digest"],
                "receipt": deepcopy(receipt),
                "imported_at": now_iso(),
            }
        )
        _validate_queue(candidate)
        _write_queue_unlocked(candidate, queue_path)
        return receipt


def _mutate_queue(path: str | Path, mutate: Callable[[dict[str, Any]], T]) -> T:
    queue_path = _queue_path(path)
    with file_lock(queue_path):
        queue = _read_queue_unlocked(queue_path)
        result = mutate(queue)
        _write_queue_unlocked(queue, queue_path)
        return result


def _validate_queue(queue: dict[str, Any]) -> None:
    ensure_schema_v1(queue, label="task queue", error_type=InvalidQueueError)
    tasks = queue.get("tasks", [])
    if not isinstance(tasks, list):
        raise InvalidQueueError("tasks must be a list")
    seen: set[str] = set()
    for task in tasks:
        if not isinstance(task, dict):
            raise InvalidQueueError("each task must be a mapping")
        task_id = str(task.get("id", "")).strip()
        if not task_id:
            raise InvalidQueueError("task id is required")
        try:
            validate_task_id(task_id)
        except ValueError as exc:
            raise InvalidQueueError(str(exc)) from exc
        if task_id in seen:
            raise InvalidQueueError(f"duplicate task id: {task_id}")
        seen.add(task_id)
        status = task.get("status", "pending")
        if status not in VALID_STATUSES:
            raise InvalidQueueError(f"invalid status for {task_id}: {status}")
        verify = task.get("verify")
        if verify is not None:
            if not isinstance(verify, list):
                raise InvalidQueueError(f"task verify must be a list: {task_id}")
            for index, item in enumerate(verify):
                if not isinstance(item, str) or not item.strip():
                    raise InvalidQueueError(
                        f"task verify[{index}] must be a non-empty string: {task_id}"
                    )
        revision = task.get("revision")
        if revision is not None and (isinstance(revision, bool) or not isinstance(revision, int) or revision < 0):
            raise InvalidQueueError(f"task revision must be a non-negative integer: {task_id}")
        failure_count = task.get("autodev_failure_count")
        if failure_count is not None and (
            isinstance(failure_count, bool)
            or not isinstance(failure_count, int)
            or failure_count < 0
        ):
            raise InvalidQueueError(
                f"task autodev_failure_count must be a non-negative integer: {task_id}"
            )
        last_failure = task.get("last_autodev_failure")
        if last_failure is not None:
            if not isinstance(last_failure, dict):
                raise InvalidQueueError(
                    f"task last_autodev_failure must be a mapping: {task_id}"
                )
            failure_run_id = last_failure.get("run_id")
            if failure_run_id is not None and not isinstance(failure_run_id, str):
                raise InvalidQueueError(
                    f"task last_autodev_failure.run_id must be a string: {task_id}"
                )
        required_gate = task.get("required_gate")
        if required_gate is not None and required_gate != INDEPENDENT_REVIEW_GATE:
            raise InvalidQueueError(f"unsupported task required_gate for {task_id}: {required_gate}")
        lease_token = task.get("lease_token")
        if lease_token is not None and not isinstance(lease_token, str):
            raise InvalidQueueError(f"task lease_token must be a string: {task_id}")
        owner = task.get("owner")
        if owner is not None and not isinstance(owner, str):
            raise InvalidQueueError(f"task owner must be a string: {task_id}")
        resources = task.get("exclusive_resources")
        if resources is not None:
            if not isinstance(resources, list):
                raise InvalidQueueError(
                    f"task exclusive_resources must be a list: {task_id}"
                )
            normalized_resources: list[str] = []
            for index, resource in enumerate(resources):
                if not isinstance(resource, str) or not resource.strip():
                    raise InvalidQueueError(
                        f"task exclusive_resources[{index}] must be a non-empty string: {task_id}"
                    )
                normalized_resources.append(resource.strip())
            if len(set(normalized_resources)) != len(normalized_resources):
                raise InvalidQueueError(
                    f"task exclusive_resources must not contain duplicates: {task_id}"
                )
        if status == "proposed":
            if not str(task.get("title") or "").strip():
                raise InvalidQueueError(f"proposed task title is required: {task_id}")
            if not str(task.get("goal") or "").strip():
                raise InvalidQueueError(f"proposed task goal is required: {task_id}")
            if not isinstance(task.get("acceptance"), list):
                raise InvalidQueueError(f"proposed task acceptance must be a list: {task_id}")
            if not isinstance(task.get("verify"), list):
                raise InvalidQueueError(f"proposed task verify must be a list: {task_id}")
            source = task.get("source")
            if not isinstance(source, dict) or not source.get("refs"):
                raise InvalidQueueError(f"proposed task source.refs is required: {task_id}")
    for task in tasks:
        task_id = str(task.get("id", "")).strip()
        for dependency in task.get("dependencies", []) or []:
            dependency_id = str(dependency).strip()
            if not dependency_id:
                raise InvalidQueueError(f"empty dependency for {task_id}")
            if dependency_id == task_id:
                raise InvalidQueueError(f"task cannot depend on itself: {task_id}")
            if dependency_id not in seen:
                raise InvalidQueueError(f"unknown dependency for {task_id}: {dependency_id}")


def _task_by_id(queue: dict[str, Any], task_id: str) -> dict[str, Any]:
    for task in queue.get("tasks", []):
        if task.get("id") == task_id:
            return task
    raise TaskNotFoundError(f"task not found: {task_id}")


def _done_task_ids(queue: dict[str, Any]) -> set[str]:
    return {str(task["id"]) for task in queue.get("tasks", []) if task.get("status") in TERMINAL_STATUSES}


def _deps_ready(queue: dict[str, Any], task: dict[str, Any]) -> bool:
    done = _done_task_ids(queue)
    return all(str(dependency).strip() in done for dependency in task.get("dependencies", []) or [])


def ready_tasks(queue: dict[str, Any]) -> list[dict[str, Any]]:
    tasks = [task for task in queue.get("tasks", []) if task.get("status") == "pending" and _deps_ready(queue, task)]
    return sorted(tasks, key=lambda task: (PRIORITY_ORDER.get(task.get("priority", "P2"), 2), task.get("id", "")))


def next_task(queue: dict[str, Any]) -> dict[str, Any] | None:
    ready = ready_tasks(queue)
    return ready[0] if ready else None


def ready_task_candidates(path: str | Path, *, limit: int) -> list[dict[str, Any]]:
    if isinstance(limit, bool) or limit <= 0:
        raise ValueError("ready candidate limit must be positive")
    return ready_tasks(load_queue(path))[:limit]


def _next_task_id(queue: dict[str, Any]) -> str:
    max_number = 0
    for task in queue.get("tasks", []):
        raw = str(task.get("id", ""))
        if raw.startswith("H-"):
            try:
                max_number = max(max_number, int(raw[2:]))
            except ValueError:
                continue
    return f"H-{max_number + 1:03d}"


def _append_note(task: dict[str, Any], note: str) -> None:
    if note:
        task.setdefault("notes", []).append({"at": now_iso(), "text": note})


def _task_revision(task: dict[str, Any]) -> int:
    raw = task.get("revision", 0)
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise InvalidQueueError(f"task revision must be a non-negative integer: {task.get('id')}")
    return raw


def _bump_revision(task: dict[str, Any]) -> int:
    revision = _task_revision(task) + 1
    task["revision"] = revision
    return revision


def _release_lease(task: dict[str, Any]) -> None:
    task.pop("lease_token", None)
    task["lease_released_at"] = now_iso()


def _require_active_lease(
    task: dict[str, Any],
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
    if _task_revision(task) != expected_revision:
        raise LeaseConflictError(f"task revision changed: {task_id}")


def _max_in_progress(queue: dict[str, Any]) -> int:
    return int(queue.get("policy", {}).get("max_in_progress") or 1)


def get_task(path: str | Path, task_id: str) -> dict[str, Any]:
    return _task_by_id(load_queue(path), task_id)


def claim_task(
    path: str | Path,
    *,
    task_id: str = "",
    owner: str = "codex",
    note: str = "",
    resume_blocked: bool = False,
    lease_token: str = "",
) -> dict[str, Any]:
    def mutate(queue: dict[str, Any]) -> dict[str, Any]:
        if task_id:
            existing = _task_by_id(queue, task_id)
            if existing.get("status") == "in_progress":
                qualifier = "legacy tokenless " if not existing.get("lease_token") else ""
                raise InProgressExistsError(
                    f"{qualifier}in_progress task requires explicit reconcile before reclaim: {task_id}"
                )
        in_progress = [task for task in queue.get("tasks", []) if task.get("status") == "in_progress"]
        if len(in_progress) >= _max_in_progress(queue):
            raise InProgressExistsError("已有 in_progress 任务，请先 done/block 当前任务")
        task = _task_by_id(queue, task_id) if task_id else next_task(queue)
        if not task:
            raise NoReadyTaskError("没有可领取的 pending 任务")
        if task.get("status") == "blocked" and resume_blocked:
            task["status"] = "pending"
            task["blocked_reason"] = ""
            task["next_action"] = ""
            _append_note(task, "resume blocked task for claim")
        if task.get("status") != "pending":
            raise InvalidTaskStatusError(f"任务不是 pending 状态: {task['id']} -> {task.get('status')}")
        if not _deps_ready(queue, task):
            raise DependencyBlockedError(f"任务依赖未完成: {task['id']}")
        task["status"] = "in_progress"
        task["owner"] = owner or "autodev"
        task["lease_token"] = lease_token or secrets.token_urlsafe(24)
        task["lease_acquired_at"] = now_iso()
        _bump_revision(task)
        task["started_at"] = task.get("started_at") or now_iso()
        task["updated_at"] = now_iso()
        _append_note(task, note or f"{owner} claimed task")
        return task

    return _mutate_queue(path, mutate)


def complete_task(
    path: str | Path,
    *,
    task_id: str,
    note: str = "",
    artifacts: list[str] | None = None,
    expected_owner: str = "",
    expected_lease_token: str = "",
    expected_revision: int | None = None,
    force_reconcile: bool = False,
    review_passed: bool = False,
) -> dict[str, Any]:
    def mutate(queue: dict[str, Any]) -> dict[str, Any]:
        task = _task_by_id(queue, task_id)
        if task.get("required_gate") == INDEPENDENT_REVIEW_GATE and not review_passed:
            raise InvalidTaskStatusError(
                f"task {task_id} requires independent review; resume it and run AutoDev "
                "again instead of force-reconciling it to done"
            )
        if force_reconcile:
            if task.get("status") not in {"in_progress", "pending", "blocked"}:
                raise InvalidTaskStatusError(f"任务不能完成: {task_id} -> {task.get('status')}")
        else:
            _require_active_lease(
                task,
                expected_owner=expected_owner,
                expected_lease_token=expected_lease_token,
                expected_revision=expected_revision,
            )
        if task.get("status") not in {"in_progress", "pending", "blocked"}:
            raise InvalidTaskStatusError(f"任务不能完成: {task_id} -> {task.get('status')}")
        task["status"] = "done"
        task["completion_mode"] = "manual_reconcile" if force_reconcile else "autodev_reviewed"
        _bump_revision(task)
        _release_lease(task)
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
        _append_note(task, note or "done")
        return task

    return _mutate_queue(path, mutate)


def release_task(
    path: str | Path,
    *,
    task_id: str,
    note: str = "",
    expected_owner: str,
    expected_lease_token: str,
    expected_revision: int,
) -> dict[str, Any]:
    """CAS-release an active claim back to pending without recording failure."""

    def mutate(queue: dict[str, Any]) -> dict[str, Any]:
        task = _task_by_id(queue, task_id)
        _require_active_lease(
            task,
            expected_owner=expected_owner,
            expected_lease_token=expected_lease_token,
            expected_revision=expected_revision,
        )
        previous_owner = str(task.get("owner") or "")
        task["status"] = "pending"
        _bump_revision(task)
        _release_lease(task)
        task["released_from_owner"] = previous_owner
        task["owner"] = ""
        task["updated_at"] = now_iso()
        _append_note(task, note or "claim released without task failure")
        return task

    return _mutate_queue(path, mutate)


def block_task(
    path: str | Path,
    *,
    task_id: str,
    reason: str,
    next_action: str = "",
    expected_owner: str = "",
    expected_lease_token: str = "",
    expected_revision: int | None = None,
    force_reconcile: bool = False,
    failure_status: str = "",
    failure_run_id: str = "",
) -> dict[str, Any]:
    def mutate(queue: dict[str, Any]) -> dict[str, Any]:
        task = _task_by_id(queue, task_id)
        if task.get("status") in TERMINAL_STATUSES:
            raise InvalidTaskStatusError(f"已结束任务不能阻塞: {task_id}")
        if task.get("status") == "proposed":
            raise InvalidTaskStatusError(f"proposed 任务未批准，不能 block: {task_id}")
        if not force_reconcile:
            _require_active_lease(
                task,
                expected_owner=expected_owner,
                expected_lease_token=expected_lease_token,
                expected_revision=expected_revision,
            )
        task["status"] = "blocked"
        _bump_revision(task)
        _release_lease(task)
        task["blocked_reason"] = reason
        task["next_action"] = next_action
        if failure_status:
            failure_count = int(task.get("autodev_failure_count") or 0) + 1
            task["autodev_failure_count"] = failure_count
            task["last_autodev_failure"] = {
                "status": failure_status,
                "at": now_iso(),
                "count": failure_count,
            }
            if failure_run_id:
                task["last_autodev_failure"]["run_id"] = failure_run_id
            if failure_status in REVIEW_GATED_FAILURE_STATUSES:
                task["required_gate"] = INDEPENDENT_REVIEW_GATE
        task["updated_at"] = now_iso()
        _append_note(task, f"blocked: {reason}")
        return task

    return _mutate_queue(path, mutate)


def resume_task(
    path: str | Path,
    *,
    task_id: str,
    note: str = "",
    reset_failure_budget: bool = False,
) -> dict[str, Any]:
    def mutate(queue: dict[str, Any]) -> dict[str, Any]:
        task = _task_by_id(queue, task_id)
        if task.get("status") != "blocked":
            raise InvalidTaskStatusError(f"只有 blocked 任务可以 resume: {task_id} -> {task.get('status')}")
        if not _deps_ready(queue, task):
            raise DependencyBlockedError(f"任务依赖未完成: {task_id}")
        task["status"] = "pending"
        _bump_revision(task)
        _release_lease(task)
        task["blocked_reason"] = ""
        task["next_action"] = ""
        if reset_failure_budget:
            task["autodev_failure_count"] = 0
            task.pop("last_autodev_failure", None)
        task["updated_at"] = now_iso()
        resume_note = note or "resumed blocked task"
        if reset_failure_budget:
            resume_note = f"{resume_note} [failure budget reset by human]"
        _append_note(task, resume_note)
        return task

    return _mutate_queue(path, mutate)


def skip_task(path: str | Path, *, task_id: str, reason: str) -> dict[str, Any]:
    def mutate(queue: dict[str, Any]) -> dict[str, Any]:
        task = _task_by_id(queue, task_id)
        if task.get("status") == "done":
            raise InvalidTaskStatusError(f"已完成任务不能跳过: {task_id}")
        task["status"] = "skipped"
        _bump_revision(task)
        _release_lease(task)
        task["finished_at"] = now_iso()
        task["updated_at"] = now_iso()
        _append_note(task, f"skipped: {reason}")
        return task

    return _mutate_queue(path, mutate)


def add_task(path: str | Path, *, title: str, priority: str = "P2", area: str = "", goal: str = "", acceptance: list[str] | None = None, verify: list[str] | None = None, dependencies: list[str] | None = None) -> dict[str, Any]:
    if priority not in PRIORITY_ORDER:
        raise ValueError(f"invalid priority: {priority}")

    def mutate(queue: dict[str, Any]) -> dict[str, Any]:
        task = {
            "id": _next_task_id(queue),
            "title": title,
            "status": "pending",
            "priority": priority,
            "area": area,
            "goal": goal,
            "dependencies": dependencies or [],
            "acceptance": acceptance or [],
            "verify": verify or [],
            "artifacts": [],
            "notes": [],
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }
        queue.setdefault("tasks", []).append(task)
        return task

    return _mutate_queue(path, mutate)


def propose_task(path: str | Path, *, title: str, goal: str, acceptance: list[str], verify: list[str], source_refs: list[str], priority: str = "P2", area: str = "", proposed_by: str = "agent", dependencies: list[str] | None = None) -> dict[str, Any]:
    if priority not in PRIORITY_ORDER:
        raise ValueError(f"invalid priority: {priority}")
    cleaned_sources = [str(item).strip() for item in source_refs if str(item).strip()]
    if not cleaned_sources:
        raise ValueError("proposed task requires at least one source ref")
    if not str(goal or "").strip():
        raise ValueError("proposed task requires goal")

    def mutate(queue: dict[str, Any]) -> dict[str, Any]:
        task = {
            "id": _next_task_id(queue),
            "title": title,
            "status": "proposed",
            "priority": priority,
            "area": area,
            "goal": goal,
            "dependencies": dependencies or [],
            "acceptance": acceptance,
            "verify": verify,
            "source": {"proposed_by": proposed_by, "refs": cleaned_sources},
            "artifacts": [],
            "notes": [{"at": now_iso(), "text": "proposed; 未批准，不会自动开发"}],
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }
        queue.setdefault("tasks", []).append(task)
        return task

    return _mutate_queue(path, mutate)


def approve_task(path: str | Path, *, task_id: str, approver: str = "human", note: str = "") -> dict[str, Any]:
    def mutate(queue: dict[str, Any]) -> dict[str, Any]:
        task = _task_by_id(queue, task_id)
        if task.get("status") != "proposed":
            raise InvalidTaskStatusError(f"只有 proposed 任务可以 approve: {task_id} -> {task.get('status')}")
        task["status"] = "pending"
        _bump_revision(task)
        task["approved_by"] = approver
        task["approved_at"] = now_iso()
        task["updated_at"] = now_iso()
        _append_note(task, note or f"approved by {approver}")
        return task

    return _mutate_queue(path, mutate)


def _summary_task(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(task.get("id") or ""),
        "title": str(task.get("title") or ""),
        "priority": str(task.get("priority") or "P2"),
        "area": str(task.get("area") or ""),
        "goal": str(task.get("goal") or ""),
        "source": task.get("source") or {},
        "approval_required": True,
        "note": "未批准，不会自动开发",
    }


def queue_summary(queue: dict[str, Any]) -> dict[str, Any]:
    counts = {status: 0 for status in sorted(VALID_STATUSES)}
    for task in queue.get("tasks", []):
        status = task.get("status", "pending")
        counts[status] = counts.get(status, 0) + 1
    current = [task for task in queue.get("tasks", []) if task.get("status") == "in_progress"]
    proposed = sorted(
        [task for task in queue.get("tasks", []) if task.get("status") == "proposed"],
        key=lambda task: (PRIORITY_ORDER.get(task.get("priority", "P2"), 2), task.get("id", "")),
    )
    upcoming = next_task(queue)
    return {
        "counts": counts,
        "in_progress": [task["id"] for task in current],
        "next": upcoming["id"] if upcoming else "",
        "proposed": [_summary_task(task) for task in proposed],
    }
