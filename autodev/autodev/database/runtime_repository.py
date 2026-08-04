"""PostgreSQL runtime lease and host-capacity repository."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import os
import secrets
import socket
from typing import Any, Callable, Mapping

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from autodev.host_capacity import process_start_identity
from autodev.persistence import (
    PersistenceConflictError,
    PersistenceNotFoundError,
)

from .engine import Database
from .models import CapacityRequest, HostRuntimeState, RuntimeLease


ACTIVE_LEASE = "active"
WAITING_REQUEST = "waiting"


class RuntimeLeaseAlreadyActiveError(PersistenceConflictError):
    """The exact runtime lease key is still owned by a live process."""


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _as_utc(value: datetime) -> datetime:
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


class DatabaseRuntimeCapacity:
    """One-host allocator with a fixed host-row lock and fencing tokens."""

    def __init__(
        self,
        database: Database,
        *,
        host_id: str | None = None,
        max_active_workers: int,
        provider_limits: Mapping[str, int] | None = None,
        lease_ttl_seconds: float = 30.0,
        clock: Callable[[], datetime] | None = None,
        process_probe: Callable[[int], str] = process_start_identity,
    ) -> None:
        if max_active_workers <= 0:
            raise ValueError("max_active_workers must be positive")
        if lease_ttl_seconds <= 0:
            raise ValueError("lease_ttl_seconds must be positive")
        limits = {str(key): int(value) for key, value in (provider_limits or {}).items()}
        if any(not key or value <= 0 for key, value in limits.items()):
            raise ValueError("provider limits must use non-empty names and positive values")
        self.database = database
        self.host_id = host_id or socket.gethostname()
        self.max_active_workers = max_active_workers
        self.provider_limits = limits
        self.lease_ttl_seconds = lease_ttl_seconds
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._process_probe = process_probe

    def _now(self) -> datetime:
        value = self._clock()
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)

    def _host_state(
        self, session: Session, *, lock: bool, create: bool = True
    ) -> HostRuntimeState:
        statement = select(HostRuntimeState).where(
            HostRuntimeState.host_id == self.host_id
        )
        row = session.scalar(statement.with_for_update() if lock else statement)
        if row is None:
            if not create:
                raise PersistenceNotFoundError(
                    f"host runtime state not found: {self.host_id}"
                )
            try:
                with session.begin_nested():
                    row = HostRuntimeState(
                        host_id=self.host_id,
                        max_active_workers=self.max_active_workers,
                        provider_limits=deepcopy(self.provider_limits),
                        fence_counters={},
                        version=1,
                    )
                    session.add(row)
                    session.flush()
            except IntegrityError:
                row = session.scalar(
                    statement.with_for_update() if lock else statement
                )
                if row is None:
                    raise PersistenceConflictError(
                        f"host runtime initialization conflict: {self.host_id}"
                    )
        if (
            row.max_active_workers != self.max_active_workers
            or dict(row.provider_limits) != self.provider_limits
        ):
            raise PersistenceConflictError(
                f"host runtime policy conflict: {self.host_id}"
            )
        return row

    def ensure_host(self) -> int:
        with self.database.unit_of_work() as session:
            return self._host_state(session, lock=True).id

    def _active_leases(
        self, session: Session, state: HostRuntimeState, *, lock: bool
    ) -> list[RuntimeLease]:
        statement = select(RuntimeLease).where(
            RuntimeLease.host_state_id == state.id,
            RuntimeLease.status == ACTIVE_LEASE,
        )
        if lock:
            statement = statement.with_for_update()
        return list(session.scalars(statement).all())

    def _waiting_requests(
        self, session: Session, state: HostRuntimeState, *, lock: bool
    ) -> list[CapacityRequest]:
        statement = (
            select(CapacityRequest)
            .where(
                CapacityRequest.host_state_id == state.id,
                CapacityRequest.status == WAITING_REQUEST,
            )
            .order_by(CapacityRequest.requested_at, CapacityRequest.id)
        )
        if lock:
            statement = statement.with_for_update()
        return list(session.scalars(statement).all())

    def _expire(self, leases: list[RuntimeLease]) -> None:
        now = self._now()
        for lease in leases:
            if _as_utc(lease.expires_at) <= now:
                lease.status = "expired"

    def _assert_process_identity(
        self, pid: int, expected: str, *, label: str = "process"
    ) -> None:
        actual = self._process_probe(pid)
        if not expected or not actual or actual != expected:
            raise PersistenceConflictError(f"{label} start identity changed")

    def request(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        """Create an idempotent waiting request without partially allocating."""
        value = deepcopy(dict(request))
        request_id = str(value.get("request_id") or secrets.token_urlsafe(18))
        project_key = str(value.get("project_id") or value.get("project_key") or "").strip()
        worker_id = str(value.get("worker_id") or "").strip()
        run_id = str(value.get("run_id") or "").strip()
        kind = str(value.get("kind") or "worker").strip()
        if not project_key or not kind:
            raise ValueError("project_id and kind are required")
        if kind != "worker":
            raise ValueError("capacity request kind must be worker")
        lease_key = str(
            value.get("lease_key")
            or ":".join((kind, project_key, worker_id, run_id))
        )
        provider = str(value.get("provider") or "").strip()
        if provider and provider not in self.provider_limits:
            raise ValueError(f"unknown bounded provider: {provider}")
        resources = sorted(
            {str(item).strip() for item in value.get("resources", []) if str(item).strip()}
        )
        pid = int(value.get("pid") or os.getpid())
        identity = str(value.get("process_start_identity") or self._process_probe(pid))
        self._assert_process_identity(pid, identity)
        supervisor_pid = int(value.get("supervisor_pid") or pid)
        supervisor_identity = str(
            value.get("supervisor_start_identity")
            or self._process_probe(supervisor_pid)
        )
        self._assert_process_identity(
            supervisor_pid, supervisor_identity, label="supervisor process"
        )
        now = self._now()
        with self.database.unit_of_work() as session:
            state = self._host_state(session, lock=True)
            existing = session.scalar(
                select(CapacityRequest)
                .where(CapacityRequest.request_id == request_id)
                .with_for_update()
            )
            if existing is not None:
                expected = (
                    existing.host_state_id,
                    existing.lease_key,
                    existing.project_key,
                    existing.worker_id or "",
                    existing.run_id or "",
                )
                actual = (state.id, lease_key, project_key, worker_id, run_id)
                if expected != actual:
                    raise PersistenceConflictError(
                        f"capacity request id conflict: {request_id}"
                    )
                existing.heartbeat_at = now
                return self._request_value(existing)
            row = CapacityRequest(
                host_state_id=state.id,
                request_id=request_id,
                lease_key=lease_key,
                kind=kind,
                project_key=project_key,
                worker_id=worker_id or None,
                run_id=run_id or None,
                provider=provider or None,
                resources=resources,
                priority=int(value.get("priority") or 10),
                status=WAITING_REQUEST,
                pid=pid,
                process_start_identity=identity,
                supervisor_pid=supervisor_pid,
                supervisor_start_identity=supervisor_identity,
                requested_at=now,
                heartbeat_at=now,
                detail=deepcopy(value.get("detail")) if value.get("detail") else None,
            )
            session.add(row)
            session.flush()
            return self._request_value(row)

    @staticmethod
    def _request_value(row: CapacityRequest) -> dict[str, Any]:
        return {
            "request_id": row.request_id,
            "status": row.status,
            "host_id": row.host_state_id,
            "lease_key": row.lease_key,
            "kind": row.kind,
            "project_id": row.project_key,
            "worker_id": row.worker_id or "",
            "run_id": row.run_id or "",
            "provider": row.provider or "",
            "resources": list(row.resources),
            "priority": row.priority,
            "requested_at": row.requested_at.isoformat(),
        }

    def _allocatable(
        self,
        request: CapacityRequest,
        leases: list[RuntimeLease],
        state: HostRuntimeState,
    ) -> bool:
        workers = [lease for lease in leases if lease.kind == "worker"]
        if request.kind != "provider" and len(workers) >= state.max_active_workers:
            return False
        if request.provider:
            limit = dict(state.provider_limits).get(request.provider)
            if limit is not None and sum(
                lease.provider == request.provider for lease in workers
            ) >= int(limit):
                return False
        occupied = {
            str(resource)
            for lease in workers
            for resource in (lease.resources or [])
        }
        return not occupied.intersection(request.resources or [])

    def _selected(
        self,
        requests: list[CapacityRequest],
        leases: list[RuntimeLease],
        state: HostRuntimeState,
    ) -> CapacityRequest | None:
        heads: dict[str, CapacityRequest] = {}
        for request in sorted(
            requests,
            key=lambda row: (row.requested_at, row.id),
        ):
            heads.setdefault(request.project_key, request)
        projects = sorted(heads)
        last = state.last_granted_project or ""
        if last in projects:
            pivot = projects.index(last) + 1
            projects = projects[pivot:] + projects[:pivot]
        candidates = [heads[project] for project in projects]
        candidates.sort(
            key=lambda row: (
                row.priority,
                projects.index(row.project_key),
                row.requested_at,
                row.id,
            )
        )
        return next(
            (request for request in candidates if self._allocatable(request, leases, state)),
            None,
        )

    def _selected_provider(
        self,
        request: CapacityRequest,
        requests: list[CapacityRequest],
        leases: list[RuntimeLease],
        state: HostRuntimeState,
    ) -> CapacityRequest | None:
        contenders = sorted(
            (
                row
                for row in requests
                if row.kind == "provider" and row.provider == request.provider
            ),
            key=lambda row: (row.priority, row.requested_at, row.id),
        )
        return next(
            (row for row in contenders if self._allocatable(row, leases, state)),
            None,
        )

    def try_grant(self, request_id: str) -> Mapping[str, Any] | None:
        """Atomically grant the selected waiter and all requested resources."""
        with self.database.unit_of_work() as session:
            state = self._host_state(session, lock=True)
            leases = self._active_leases(session, state, lock=True)
            self._expire(leases)
            leases = [lease for lease in leases if lease.status == ACTIVE_LEASE]
            requests = self._waiting_requests(session, state, lock=True)
            request = next(
                (row for row in requests if row.request_id == request_id), None
            )
            if request is None:
                existing = session.scalar(
                    select(CapacityRequest).where(
                        CapacityRequest.request_id == request_id
                    )
                )
                if existing is None:
                    raise PersistenceNotFoundError(
                        f"capacity request not found: {request_id}"
                    )
                return None
            self._assert_process_identity(
                request.pid, request.process_start_identity
            )
            selected = (
                self._selected_provider(request, requests, leases, state)
                if request.kind == "provider"
                else self._selected(requests, leases, state)
            )
            if selected is None or selected.id != request.id:
                request.heartbeat_at = self._now()
                return None
            if any(
                lease.lease_key == request.lease_key for lease in leases
            ) and request.kind != "provider":
                raise PersistenceConflictError(
                    f"runtime lease already active: {request.lease_key}"
                )
            if request.kind == "provider":
                target = next(
                    (
                        lease
                        for lease in leases
                        if lease.lease_key == request.lease_key
                        and lease.fencing_token
                        == int((request.detail or {}).get("fencing_token") or 0)
                    ),
                    None,
                )
                if target is None:
                    request.status = "cancelled"
                    raise PersistenceConflictError(
                        "provider request owner lease is no longer active"
                    )
                target.provider = request.provider
                target.heartbeat_at = self._now()
                target.expires_at = target.heartbeat_at + timedelta(
                    seconds=self.lease_ttl_seconds
                )
                request.status = "granted"
                return self._lease_value(target)
            counters = dict(state.fence_counters)
            fencing_token = int(counters.get(request.lease_key, 0)) + 1
            counters[request.lease_key] = fencing_token
            state.fence_counters = counters
            state.last_granted_project = request.project_key
            state.version += 1
            token = secrets.token_urlsafe(32)
            now = self._now()
            lease = RuntimeLease(
                host_state_id=state.id,
                lease_key=request.lease_key,
                kind=request.kind,
                project_key=request.project_key,
                worker_id=request.worker_id,
                run_id=request.run_id,
                provider=request.provider,
                resources=list(request.resources),
                token_digest=_token_digest(token),
                fencing_token=fencing_token,
                status=ACTIVE_LEASE,
                pid=request.pid,
                process_start_identity=request.process_start_identity,
                supervisor_pid=request.supervisor_pid,
                supervisor_start_identity=request.supervisor_start_identity,
                heartbeat_at=now,
                expires_at=now + timedelta(seconds=self.lease_ttl_seconds),
                detail=deepcopy(request.detail),
            )
            session.add(lease)
            request.status = "granted"
            session.flush()
            return self._lease_value(lease, token=token)

    def acquire(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        waiting = self.request(request)
        granted = self.try_grant(str(waiting["request_id"]))
        return granted or waiting

    def acquire_runtime(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        """Acquire a non-capacity supervisor/run lease under the host fence."""
        value = deepcopy(dict(request))
        kind = str(value.get("kind") or "runtime").strip()
        if kind in {"worker", "provider"}:
            raise ValueError("worker/provider leases must use capacity requests")
        project_key = str(value.get("project_id") or "").strip()
        lease_key = str(value.get("lease_key") or "").strip()
        if not project_key or not lease_key:
            raise ValueError("project_id and lease_key are required")
        pid = int(value.get("pid") or os.getpid())
        identity = str(value.get("process_start_identity") or self._process_probe(pid))
        self._assert_process_identity(pid, identity)
        now = self._now()
        with self.database.unit_of_work() as session:
            state = self._host_state(session, lock=True)
            active = self._active_leases(session, state, lock=True)
            self._expire(active)
            if any(
                lease.status == ACTIVE_LEASE and lease.lease_key == lease_key
                for lease in active
            ):
                raise RuntimeLeaseAlreadyActiveError(
                    f"runtime lease already active: {lease_key}"
                )
            counters = dict(state.fence_counters)
            fencing_token = int(counters.get(lease_key, 0)) + 1
            counters[lease_key] = fencing_token
            state.fence_counters = counters
            token = secrets.token_urlsafe(32)
            lease = RuntimeLease(
                host_state_id=state.id,
                lease_key=lease_key,
                kind=kind,
                project_key=project_key,
                worker_id=str(value.get("worker_id") or "") or None,
                run_id=str(value.get("run_id") or "") or None,
                provider=None,
                resources=[],
                token_digest=_token_digest(token),
                fencing_token=fencing_token,
                status=ACTIVE_LEASE,
                pid=pid,
                process_start_identity=identity,
                supervisor_pid=None,
                supervisor_start_identity=None,
                heartbeat_at=now,
                expires_at=now + timedelta(seconds=self.lease_ttl_seconds),
                detail=deepcopy(value.get("detail")) if value.get("detail") else None,
            )
            session.add(lease)
            session.flush()
            return self._lease_value(lease, token=token)

    def request_provider(
        self,
        token: str,
        *,
        fencing_token: int,
        provider: str,
        priority: int = 10,
        request_id: str = "",
    ) -> Mapping[str, Any]:
        """Release the current provider slot and enqueue a fenced transition."""
        if provider not in self.provider_limits:
            raise ValueError(f"unknown bounded provider: {provider}")
        now = self._now()
        with self.database.unit_of_work() as session:
            state = self._host_state(session, lock=True)
            lease = self._lease_by_token(session, state, token)
            self._assert_process_identity(lease.pid, lease.process_start_identity)
            if (
                lease.status != ACTIVE_LEASE
                or lease.fencing_token != fencing_token
                or lease.kind != "worker"
            ):
                raise PersistenceConflictError("runtime lease fencing conflict")
            lease.provider = None
            selected_id = request_id or secrets.token_urlsafe(18)
            existing = session.scalar(
                select(CapacityRequest)
                .where(CapacityRequest.request_id == selected_id)
                .with_for_update()
            )
            if existing is not None:
                if (
                    existing.lease_key != lease.lease_key
                    or existing.provider != provider
                ):
                    raise PersistenceConflictError(
                        f"capacity request id conflict: {selected_id}"
                    )
                existing.heartbeat_at = now
                return self._request_value(existing)
            row = CapacityRequest(
                host_state_id=state.id,
                request_id=selected_id,
                lease_key=lease.lease_key,
                kind="provider",
                project_key=lease.project_key,
                worker_id=lease.worker_id,
                run_id=lease.run_id,
                provider=provider,
                resources=[],
                priority=int(priority),
                status=WAITING_REQUEST,
                pid=lease.pid,
                process_start_identity=lease.process_start_identity,
                supervisor_pid=lease.supervisor_pid,
                supervisor_start_identity=lease.supervisor_start_identity,
                requested_at=now,
                heartbeat_at=now,
                detail={"fencing_token": fencing_token},
            )
            session.add(row)
            session.flush()
            return self._request_value(row)

    @staticmethod
    def _lease_value(
        row: RuntimeLease, *, token: str = ""
    ) -> dict[str, Any]:
        value = {
            "lease_id": row.id,
            "lease_key": row.lease_key,
            "kind": row.kind,
            "project_id": row.project_key,
            "worker_id": row.worker_id or "",
            "run_id": row.run_id or "",
            "provider": row.provider or "",
            "resources": list(row.resources),
            "status": row.status,
            "fencing_token": row.fencing_token,
            "pid": row.pid,
            "process_start_identity": row.process_start_identity,
            "supervisor_pid": row.supervisor_pid,
            "supervisor_start_identity": row.supervisor_start_identity or "",
            "heartbeat_at": row.heartbeat_at.isoformat(),
            "expires_at": row.expires_at.isoformat(),
        }
        if token:
            value["token"] = token
        return value

    def _lease_by_token(
        self, session: Session, state: HostRuntimeState, token: str
    ) -> RuntimeLease:
        row = session.scalar(
            select(RuntimeLease)
            .where(
                RuntimeLease.host_state_id == state.id,
                RuntimeLease.token_digest == _token_digest(token),
            )
            .with_for_update()
        )
        if row is None:
            raise PersistenceNotFoundError("runtime lease not found")
        return row

    def heartbeat(
        self, token: str, *, fencing_token: int
    ) -> Mapping[str, Any]:
        with self.database.unit_of_work() as session:
            state = self._host_state(session, lock=True)
            lease = self._lease_by_token(session, state, token)
            self._assert_process_identity(
                lease.pid, lease.process_start_identity
            )
            if lease.status != ACTIVE_LEASE or lease.fencing_token != fencing_token:
                raise PersistenceConflictError("runtime lease fencing conflict")
            now = self._now()
            if _as_utc(lease.expires_at) <= now:
                lease.status = "expired"
                raise PersistenceConflictError("runtime lease expired")
            lease.heartbeat_at = now
            lease.expires_at = now + timedelta(seconds=self.lease_ttl_seconds)
            return self._lease_value(lease)

    def clear_provider(self, token: str, *, fencing_token: int) -> Mapping[str, Any]:
        with self.database.unit_of_work() as session:
            state = self._host_state(session, lock=True)
            lease = self._lease_by_token(session, state, token)
            self._assert_process_identity(
                lease.pid, lease.process_start_identity
            )
            if (
                lease.status != ACTIVE_LEASE
                or lease.fencing_token != fencing_token
                or lease.kind != "worker"
            ):
                raise PersistenceConflictError("runtime lease fencing conflict")
            now = self._now()
            if _as_utc(lease.expires_at) <= now:
                lease.status = "expired"
                raise PersistenceConflictError("runtime lease expired")
            lease.provider = None
            lease.heartbeat_at = now
            lease.expires_at = now + timedelta(seconds=self.lease_ttl_seconds)
            for request in self._waiting_requests(session, state, lock=True):
                if request.lease_key == lease.lease_key:
                    request.status = "cancelled"
            return self._lease_value(lease)

    def release(self, token: str, *, fencing_token: int) -> None:
        with self.database.unit_of_work() as session:
            state = self._host_state(session, lock=True)
            lease = self._lease_by_token(session, state, token)
            if lease.status != ACTIVE_LEASE or lease.fencing_token != fencing_token:
                raise PersistenceConflictError("runtime lease fencing conflict")
            lease.status = "released"
            lease.expires_at = self._now()
            for request in self._waiting_requests(session, state, lock=True):
                if request.lease_key == lease.lease_key:
                    request.status = "cancelled"

    def cancel(self, request_id: str) -> None:
        with self.database.unit_of_work() as session:
            state = self._host_state(session, lock=True)
            row = session.scalar(
                select(CapacityRequest)
                .where(
                    CapacityRequest.host_state_id == state.id,
                    CapacityRequest.request_id == request_id,
                )
                .with_for_update()
            )
            if row is None:
                raise PersistenceNotFoundError(
                    f"capacity request not found: {request_id}"
                )
            if row.status == WAITING_REQUEST:
                row.status = "cancelled"

    def snapshot(self) -> Mapping[str, Any]:
        try:
            with self.database.unit_of_work() as session:
                state = self._host_state(session, lock=False, create=False)
                leases = self._active_leases(session, state, lock=False)
                requests = self._waiting_requests(session, state, lock=False)
                now = self._now()
                live = [
                    lease for lease in leases if _as_utc(lease.expires_at) > now
                ]
                stale = [
                    lease for lease in leases if _as_utc(lease.expires_at) <= now
                ]
                workers = [lease for lease in live if lease.kind == "worker"]
                return {
                    "controlled": True,
                    "host_id": self.host_id,
                    "max_active_workers": state.max_active_workers,
                    "occupied": len(workers),
                    "stale": len(stale),
                    "provider_limits": deepcopy(state.provider_limits),
                    "provider_occupied": {
                        provider: sum(
                            lease.provider == provider for lease in workers
                        )
                        for provider in state.provider_limits
                    },
                    "leases": [
                        self._lease_value(lease) for lease in live + stale
                    ],
                    "waiters": [
                        self._request_value(request) for request in requests
                    ],
                }
        except PersistenceNotFoundError:
            return {
                "controlled": False,
                "host_id": self.host_id,
                "max_active_workers": self.max_active_workers,
                "occupied": 0,
                "stale": 0,
                "provider_limits": deepcopy(self.provider_limits),
                "provider_occupied": {
                    provider: 0 for provider in self.provider_limits
                },
                "leases": [],
                "waiters": [],
            }


class DatabaseRuntimeLeasePort:
    def __init__(self, repository: DatabaseRuntimeCapacity) -> None:
        self.repository = repository

    def acquire(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        return self.repository.acquire_runtime(request)

    def heartbeat(
        self, token: str, *, fencing_token: int
    ) -> Mapping[str, Any]:
        return self.repository.heartbeat(token, fencing_token=fencing_token)

    def release(self, token: str, *, fencing_token: int) -> None:
        self.repository.release(token, fencing_token=fencing_token)


class DatabaseCapacityPort:
    def __init__(self, repository: DatabaseRuntimeCapacity) -> None:
        self.repository = repository

    def request(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        return self.repository.acquire(request)

    def snapshot(self) -> Mapping[str, Any]:
        return self.repository.snapshot()

    def cancel(self, request_id: str) -> None:
        self.repository.cancel(request_id)
