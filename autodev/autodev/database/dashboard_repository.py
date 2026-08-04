"""Read-only, cross-project dashboard snapshots from PostgreSQL."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import socket
from typing import Any, Callable

from sqlalchemy import func, select

from autodev.adapters.queue_yaml import queue_summary
from autodev.persistence import PersistenceNotFoundError
from autodev.queue_adapter import _task_snapshot

from .engine import Database
from .models import (
    ArtifactIndex,
    CapacityRequest,
    HostRuntimeState,
    Landing,
    Project,
    QueueManifest,
    QueueTask,
    Run,
    RunEvent,
    RuntimeLease,
)


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


def _is_active_run_status(status: str) -> bool:
    normalized = str(status or "").strip().lower()
    return normalized in ACTIVE_RUN_STATUSES or normalized.endswith("_running")


def _as_utc(value: datetime) -> datetime:
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


def _task_value(row: QueueTask) -> dict[str, Any]:
    return {**deepcopy(row.spec), **deepcopy(row.runtime)}


def _landing_value(row: Landing, project_key: str) -> dict[str, Any]:
    # Queue claim tokens are lifecycle credentials and never belong in a
    # read-only dashboard response.
    return {
        "project_id": project_key,
        "task_id": row.task_id,
        "run_id": row.run_id,
        "integration_branch": row.integration_branch,
        "expected_ref": row.expected_ref,
        "candidate_sha": row.candidate_sha,
        "push_required": bool(row.push_required),
        "pushed": bool(row.pushed),
        "state": row.state,
        "version": row.version,
        "updated_at": row.updated_at.isoformat(),
    }


class DatabaseDashboardReader:
    """Collect one consistent database-backed dashboard read snapshot."""

    def __init__(
        self,
        database: Database,
        *,
        host_id: str | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.database = database
        self.host_id = host_id or socket.gethostname()
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def _now(self) -> datetime:
        value = self._clock()
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)

    @staticmethod
    def _queue(
        session,
        project: Project,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        manifest = session.scalar(
            select(QueueManifest).where(
                QueueManifest.project_id == project.id
            )
        )
        rows = list(
            session.scalars(
                select(QueueTask)
                .where(QueueTask.project_id == project.id)
                .order_by(QueueTask.ordinal, QueueTask.task_id)
            ).all()
        )
        tasks = [_task_value(row) for row in rows]
        if manifest is None:
            return (
                {
                    "error": "database queue not initialized",
                    "counts": {},
                    "in_progress": [],
                    "next": "",
                    "proposed": [],
                },
                [_task_snapshot(task) for task in tasks],
            )
        document = {
            "schema_version": manifest.schema_version,
            "policy": deepcopy(manifest.policy),
            "tasks": tasks,
        }
        return queue_summary(document), [_task_snapshot(task) for task in tasks]

    def _capacity(
        self,
        session,
        *,
        authorized_project_keys: set[str] | frozenset[str] | None = None,
    ) -> tuple[dict[str, Any], list[RuntimeLease]]:
        state = session.scalar(
            select(HostRuntimeState).where(
                HostRuntimeState.host_id == self.host_id
            )
        )
        if state is None:
            return (
                {
                    "controlled": False,
                    "host_id": self.host_id,
                    "max_active_workers": 0,
                    "occupied": 0,
                    "live": 0,
                    "orphan": 0,
                    "needs_reconcile": 0,
                    "provider_limits": {},
                    "provider_occupied": {},
                    "leases": [],
                    "waiters": [],
                },
                [],
            )
        leases = list(
            session.scalars(
                select(RuntimeLease)
                .where(RuntimeLease.host_state_id == state.id)
                .order_by(RuntimeLease.created_at, RuntimeLease.id)
            ).all()
        )
        waiters = list(
            session.scalars(
                select(CapacityRequest)
                .where(
                    CapacityRequest.host_state_id == state.id,
                    CapacityRequest.status == "waiting",
                )
                .order_by(CapacityRequest.requested_at, CapacityRequest.id)
            ).all()
        )
        now = self._now()
        active = [row for row in leases if row.status == "active"]
        live = [row for row in active if _as_utc(row.expires_at) > now]
        stale = [row for row in active if _as_utc(row.expires_at) <= now]
        workers = [row for row in live if row.kind == "worker"]
        visible_live = (
            live
            if authorized_project_keys is None
            else [
                row
                for row in live
                if row.project_key in authorized_project_keys
            ]
        )
        visible_stale = (
            stale
            if authorized_project_keys is None
            else [
                row
                for row in stale
                if row.project_key in authorized_project_keys
            ]
        )
        visible_waiters = (
            waiters
            if authorized_project_keys is None
            else [
                row
                for row in waiters
                if row.project_key in authorized_project_keys
            ]
        )
        limits = deepcopy(state.provider_limits)
        lease_values = [
            {
                "kind": row.kind,
                "project_id": row.project_key,
                "worker_id": row.worker_id or "",
                "run_id": row.run_id or "",
                "provider": row.provider or "",
                "resources": list(row.resources or []),
                "status": "stale" if row in stale else row.status,
                "pid": row.pid,
                "heartbeat_at": row.heartbeat_at.isoformat(),
                "expires_at": row.expires_at.isoformat(),
            }
            for row in visible_live + visible_stale
        ]
        waiter_values = [
            {
                "request_id": row.request_id,
                "kind": row.kind,
                "project_id": row.project_key,
                "worker_id": row.worker_id or "",
                "run_id": row.run_id or "",
                "provider": row.provider or "",
                "resources": list(row.resources or []),
                "priority": row.priority,
                "status": row.status,
                "requested_at": row.requested_at.isoformat(),
            }
            for row in visible_waiters
        ]
        return (
            {
                "controlled": True,
                "host_id": self.host_id,
                "max_active_workers": state.max_active_workers,
                "occupied": len(workers),
                "live": len(live),
                "orphan": 0,
                "needs_reconcile": len(stale),
                "provider_limits": limits,
                "provider_occupied": {
                    provider: sum(
                        row.provider == provider for row in workers
                    )
                    for provider in limits
                },
                "leases": lease_values,
                "waiters": waiter_values,
            },
            visible_live,
        )

    @staticmethod
    def _runs(session, project: Project, limit: int) -> list[dict[str, Any]]:
        logical_updated_at = Run.snapshot["updated_at"].as_string()
        rows = list(
            session.scalars(
                select(Run)
                .where(Run.project_id == project.id)
                .order_by(
                    logical_updated_at.desc(),
                    Run.updated_at.desc(),
                    Run.id.desc(),
                )
                .limit(limit)
            ).all()
        )
        return [
            {
                "run_id": row.run_id,
                "status": row.status,
                "version": row.version,
                "snapshot": deepcopy(row.snapshot),
                "created_at": row.created_at.isoformat(),
                "updated_at": row.updated_at.isoformat(),
            }
            for row in rows
        ]

    @staticmethod
    def _run_headers(
        session,
        project: Project,
        limit: int,
    ) -> list[dict[str, Any]]:
        logical_updated_at = Run.snapshot["updated_at"].as_string()
        rows = list(
            session.execute(
                select(Run.run_id, Run.status, Run.updated_at)
                .where(Run.project_id == project.id)
                .order_by(
                    logical_updated_at.desc(),
                    Run.updated_at.desc(),
                    Run.id.desc(),
                )
                .limit(limit)
            ).all()
        )
        return [
            {
                "run_id": row.run_id,
                "status": row.status,
                "updated_at": row.updated_at.isoformat(),
            }
            for row in rows
        ]

    @staticmethod
    def _events_by_run_id(
        session,
        project: Project,
        run_ids: set[str],
        *,
        limit: int = 80,
    ) -> dict[str, list[dict[str, Any]]]:
        """Read each requested Run's latest events in one bounded query."""
        if not run_ids:
            return {}
        run_rows = list(
            session.execute(
                select(Run.id, Run.run_id).where(
                    Run.project_id == project.id,
                    Run.run_id.in_(run_ids),
                )
            ).all()
        )
        run_id_by_pk = {row.id: row.run_id for row in run_rows}
        if not run_id_by_pk:
            return {}
        ranked = (
            select(
                RunEvent.run_pk.label("run_pk"),
                RunEvent.payload.label("payload"),
                func.row_number()
                .over(
                    partition_by=RunEvent.run_pk,
                    order_by=RunEvent.seq.desc(),
                )
                .label("event_rank"),
            )
            .where(RunEvent.run_pk.in_(run_id_by_pk))
            .subquery()
        )
        event_rows = list(
            session.execute(
                select(ranked.c.run_pk, ranked.c.payload)
                .where(ranked.c.event_rank <= limit)
                .order_by(ranked.c.run_pk, ranked.c.event_rank.desc())
            ).all()
        )
        result = {run_id: [] for run_id in run_ids}
        for row in event_rows:
            run_id = run_id_by_pk.get(row.run_pk)
            if run_id:
                result[run_id].append(deepcopy(row.payload))
        return result

    def read(
        self,
        project_key: str,
        *,
        run_id: str = "",
        recent_limit: int = 64,
        include_recent_events: bool = True,
        authorized_project_keys: set[str] | frozenset[str] | None = None,
    ) -> dict[str, Any]:
        if recent_limit <= 0:
            raise ValueError("recent_limit must be positive")
        with self.database.unit_of_work() as session:
            project_query = select(Project)
            if authorized_project_keys is not None:
                if project_key not in authorized_project_keys:
                    raise PersistenceNotFoundError(
                        f"dashboard project is not authorized: {project_key}"
                    )
                project_query = project_query.where(
                    Project.project_key.in_(authorized_project_keys)
                )
            projects = list(
                session.scalars(
                    project_query.order_by(Project.name, Project.project_key)
                ).all()
            )
            selected = next(
                (
                    project
                    for project in projects
                    if project.project_key == project_key
                ),
                None,
            )
            if selected is None:
                raise PersistenceNotFoundError(
                    f"dashboard project not found: {project_key}"
                )

            capacity, live_leases = self._capacity(
                session,
                authorized_project_keys=authorized_project_keys,
            )
            live_run_ids = {
                str(row.run_id)
                for row in live_leases
                if row.run_id
            }
            live_workers_by_project: dict[str, list[dict[str, Any]]] = {}
            for row in live_leases:
                if row.kind != "worker":
                    continue
                live_workers_by_project.setdefault(row.project_key, []).append(
                    {
                        "worker_id": row.worker_id or "",
                        "run_id": row.run_id or "",
                        "status": row.status,
                        "provider": row.provider or "",
                        "resources": list(row.resources or []),
                        "pid": row.pid,
                    }
                )

            project_cards: list[dict[str, Any]] = []
            selected_queue: dict[str, Any] = {}
            selected_tasks: list[dict[str, Any]] = []
            selected_runs: list[dict[str, Any]] = []
            for project in projects:
                summary, tasks = self._queue(session, project)
                runs = (
                    self._runs(session, project, recent_limit)
                    if project.id == selected.id
                    else self._run_headers(session, project, recent_limit)
                )
                latest_run_id = runs[0]["run_id"] if runs else ""
                active_run_id = next(
                    (
                        item["run_id"]
                        for item in runs
                        if item["run_id"] in live_run_ids
                        and _is_active_run_status(item["status"])
                    ),
                    "",
                )
                stale_run_id = next(
                    (
                        item["run_id"]
                        for item in runs
                        if _is_active_run_status(item["status"])
                        and item["run_id"] not in live_run_ids
                    ),
                    "",
                )
                project_cards.append(
                    {
                        "id": project.project_key,
                        "name": project.name,
                        "repo_root": project.repo_root,
                        "config_path": "",
                        "enabled": True,
                        "current_run_id": (
                            active_run_id or stale_run_id or latest_run_id
                        ),
                        "active_run_id": active_run_id,
                        "stale_run_id": stale_run_id,
                        "latest_run_id": latest_run_id,
                        "queue": summary,
                        "status": (
                            "queue_unavailable"
                            if summary.get("error")
                            else "ok"
                        ),
                        "error": str(summary.get("error") or ""),
                        "workers": {
                            "active": len(
                                live_workers_by_project.get(
                                    project.project_key, []
                                )
                            ),
                            "workers": deepcopy(
                                live_workers_by_project.get(
                                    project.project_key, []
                                )
                            ),
                        },
                    }
                )
                if project.id == selected.id:
                    selected_queue = summary
                    selected_tasks = tasks
                    selected_runs = runs

            child_ids = {
                str(outcome.get("run_id") or "")
                for item in selected_runs[:8]
                for outcome in (
                    ((item.get("snapshot") or {}).get("loop") or {}).get(
                        "tasks"
                    )
                    or []
                )
                if isinstance(outcome, dict)
                and str(outcome.get("run_id") or "")
            }
            known_run_ids = {
                str(item.get("run_id") or "") for item in selected_runs
            }
            missing_child_ids = child_ids - known_run_ids
            if missing_child_ids:
                child_rows = list(
                    session.scalars(
                        select(Run).where(
                            Run.project_id == selected.id,
                            Run.run_id.in_(missing_child_ids),
                        )
                    ).all()
                )
                selected_runs.extend(
                    {
                        "run_id": row.run_id,
                        "status": row.status,
                        "version": row.version,
                        "snapshot": deepcopy(row.snapshot),
                        "created_at": row.created_at.isoformat(),
                        "updated_at": row.updated_at.isoformat(),
                    }
                    for row in child_rows
                )

            selected_run_id = run_id or next(
                (
                    item["run_id"]
                    for item in selected_runs
                    if item["run_id"] in live_run_ids
                    and _is_active_run_status(item["status"])
                ),
                selected_runs[0]["run_id"] if selected_runs else "",
            )
            selected_run = next(
                (
                    item
                    for item in selected_runs
                    if item["run_id"] == selected_run_id
                ),
                None,
            )
            if selected_run_id and selected_run is None:
                row = session.scalar(
                    select(Run).where(
                        Run.project_id == selected.id,
                        Run.run_id == selected_run_id,
                    )
                )
                if row is None:
                    selected_run = None
                else:
                    selected_run = {
                        "run_id": row.run_id,
                        "status": row.status,
                        "version": row.version,
                        "snapshot": deepcopy(row.snapshot),
                        "created_at": row.created_at.isoformat(),
                        "updated_at": row.updated_at.isoformat(),
                    }

            event_run_ids: set[str] = set()
            if include_recent_events:
                child_run_ids = {
                    str(outcome.get("run_id") or "")
                    for item in selected_runs
                    for outcome in (
                        ((item.get("snapshot") or {}).get("loop") or {}).get(
                            "tasks"
                        )
                        or []
                    )
                    if isinstance(outcome, dict)
                    and str(outcome.get("run_id") or "")
                }
                for item in selected_runs:
                    candidate_id = str(item.get("run_id") or "")
                    if not candidate_id or candidate_id in child_run_ids:
                        continue
                    event_run_ids.add(candidate_id)
                    event_run_ids.update(
                        str(outcome.get("run_id") or "")
                        for outcome in (
                            (
                                (item.get("snapshot") or {}).get("loop")
                                or {}
                            ).get("tasks")
                            or []
                        )
                        if isinstance(outcome, dict)
                        and str(outcome.get("run_id") or "")
                    )
                    if len(event_run_ids - child_run_ids) >= 8:
                        break
            if selected_run is not None:
                event_run_ids.add(str(selected_run.get("run_id") or ""))
            event_run_ids.discard("")
            run_events = self._events_by_run_id(
                session,
                selected,
                event_run_ids,
            )

            events: list[dict[str, Any]] = []
            artifacts: list[dict[str, Any]] = []
            if selected_run is not None:
                run_row = session.scalar(
                    select(Run).where(
                        Run.project_id == selected.id,
                        Run.run_id == selected_run["run_id"],
                    )
                )
                events = deepcopy(
                    run_events.get(str(selected_run["run_id"]), [])
                )
                artifact_rows = list(
                    session.scalars(
                        select(ArtifactIndex)
                        .where(ArtifactIndex.run_pk == run_row.id)
                        .order_by(ArtifactIndex.logical_name, ArtifactIndex.id)
                    ).all()
                )
                artifacts = [
                    {
                        "task_id": row.task_id or "",
                        "logical_name": row.logical_name,
                        "kind": row.kind,
                        "uri": row.uri,
                        "content_sha256": row.content_sha256,
                        "size_bytes": row.size_bytes,
                        "version": row.version,
                    }
                    for row in artifact_rows
                ]

            landing_rows = list(
                session.scalars(
                    select(Landing)
                    .where(
                        Landing.project_id == selected.id,
                        Landing.state.not_in(
                            ("queue_finalized", "abandoned")
                        ),
                    )
                    .order_by(Landing.updated_at, Landing.id)
                ).all()
            )
            return {
                "project": {
                    "id": selected.project_key,
                    "name": selected.name,
                    "repo_root": selected.repo_root,
                },
                "projects": project_cards,
                "queue": selected_queue,
                "queue_tasks": selected_tasks,
                "runs": selected_runs,
                "selected_run": deepcopy(selected_run),
                "events": events,
                "run_events": run_events,
                "artifacts": artifacts,
                "live_run_ids": sorted(live_run_ids),
                "workers": deepcopy(
                    live_workers_by_project.get(selected.project_key, [])
                ),
                "landings": [
                    _landing_value(row, selected.project_key)
                    for row in landing_rows
                ],
                "host_capacity": capacity,
            }

    def read_run_events(
        self,
        project_key: str,
        run_ids: set[str],
        *,
        authorized_project_keys: set[str] | frozenset[str] | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        """Read bounded event windows for an explicitly selected page."""
        if authorized_project_keys is not None:
            if project_key not in authorized_project_keys:
                raise PersistenceNotFoundError(
                    f"dashboard project is not authorized: {project_key}"
                )
        with self.database.unit_of_work() as session:
            query = select(Project).where(
                Project.project_key == project_key
            )
            if authorized_project_keys is not None:
                query = query.where(
                    Project.project_key.in_(authorized_project_keys)
                )
            project = session.scalar(query)
            if project is None:
                raise PersistenceNotFoundError(
                    f"dashboard project not found: {project_key}"
                )
            return self._events_by_run_id(session, project, run_ids)
