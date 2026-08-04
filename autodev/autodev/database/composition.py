"""Fail-closed database composition helpers for lifecycle cutover."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import secrets
from threading import RLock
import threading
import time
from typing import Any

from sqlalchemy import select

from autodev.config import AutoDevConfig
from autodev.host_capacity import (
    CAPACITY_HEARTBEAT_INTERVAL_SECONDS,
    CapacitySnapshot,
    HostCapacityUnavailable,
    HostPolicy,
    process_start_identity,
)
from autodev.persistence import (
    PersistenceConfigurationError,
    PersistenceNotFoundError,
    PersistenceUnavailableError,
)

from .config import DatabaseConfig, MODE_DATABASE, MODE_TEST, load_database_config
from .engine import Database
from .health import check_database_health
from .models import Project
from .run_repository import DatabaseRunStore, ProjectIdentity


_LOCK = RLock()
_DATABASES: dict[tuple[Any, ...], Database] = {}
_READY: set[tuple[Any, ...]] = set()


def _key(config: DatabaseConfig) -> tuple[Any, ...]:
    return (
        config.require_url(),
        config.mode,
        config.allow_sqlite,
        config.pool_size,
        config.max_overflow,
        config.pool_timeout,
    )


def database_for_runtime(
    config: DatabaseConfig | None = None,
) -> tuple[Database, DatabaseConfig]:
    selected = config or load_database_config()
    if selected.mode not in {MODE_DATABASE, MODE_TEST}:
        raise PersistenceConfigurationError(
            f"database composition requires database mode, got {selected.mode!r}"
        )
    key = _key(selected)
    with _LOCK:
        database = _DATABASES.get(key)
        if database is None:
            database = Database.from_config(selected)
            _DATABASES[key] = database
        if key not in _READY:
            if selected.mode == MODE_TEST:
                try:
                    database.ping()
                except Exception as exc:
                    raise PersistenceUnavailableError(
                        "database composition connection failed"
                    ) from exc
            else:
                health = check_database_health(database, selected)
                if not health.ok:
                    raise PersistenceUnavailableError(
                        "database composition unavailable: "
                        f"{health.error or 'health check failed'}"
                    )
            _READY.add(key)
    return database, selected


def project_identity(
    config: AutoDevConfig, *, enforce_cutover: bool = True
) -> ProjectIdentity:
    if enforce_cutover:
        from .cutover import enforce_cutover_project

        enforce_cutover_project(config.project.id, config.project.repo_root)
    return ProjectIdentity.local(config.project.id, config.project.repo_root)


def run_store_for_config(
    config: AutoDevConfig,
    *,
    database_config: DatabaseConfig | None = None,
) -> DatabaseRunStore:
    database, selected = database_for_runtime(database_config)
    return DatabaseRunStore(
        database,
        project_identity(config, enforce_cutover=not selected.allow_sqlite),
    )


def run_store_for_repo(
    repo_root: str | Path,
    *,
    database_config: DatabaseConfig | None = None,
) -> DatabaseRunStore:
    database, selected = database_for_runtime(database_config)
    resolved = str(Path(repo_root).expanduser().resolve(strict=False))
    fingerprint = hashlib.sha256(resolved.encode("utf-8")).hexdigest()
    with database.unit_of_work() as session:
        rows = list(
            session.scalars(
                select(Project).where(
                    Project.repo_root == resolved,
                    Project.repo_fingerprint == fingerprint,
                )
            ).all()
        )
        if not rows:
            raise PersistenceNotFoundError(
                f"database project not found for repo: {resolved}"
            )
        if len(rows) != 1:
            raise PersistenceConfigurationError(
                f"database project identity is ambiguous for repo: {resolved}"
            )
        row = rows[0]
        identity = ProjectIdentity(
            project_key=row.project_key,
            name=row.name,
            repo_root=row.repo_root,
            repo_fingerprint=row.repo_fingerprint,
            host_id=row.host_id,
            config_digest=row.config_digest,
        )
    if not selected.allow_sqlite:
        from .cutover import enforce_cutover_project

        enforce_cutover_project(identity.project_key, identity.repo_root)
    return DatabaseRunStore(database, identity)


def queue_port_for_config(
    config: AutoDevConfig,
    *,
    database_config: DatabaseConfig | None = None,
):
    from .queue_repository import DatabaseQueuePort, DatabaseQueueRepository

    database, selected = database_for_runtime(database_config)
    return DatabaseQueuePort(
        DatabaseQueueRepository(
            database,
            project_identity(
                config, enforce_cutover=not selected.allow_sqlite
            ),
        )
    )


def landing_store_for_config(
    config: AutoDevConfig,
    *,
    database_config: DatabaseConfig | None = None,
):
    from .landing_repository import DatabaseLandingStore

    database, selected = database_for_runtime(database_config)
    return DatabaseLandingStore(
        database,
        project_identity(config, enforce_cutover=not selected.allow_sqlite),
    )


def runtime_capacity_for_policy(
    policy: HostPolicy | None,
    *,
    database_config: DatabaseConfig | None = None,
):
    from .runtime_repository import DatabaseRuntimeCapacity

    database, _ = database_for_runtime(database_config)
    return DatabaseRuntimeCapacity(
        database,
        max_active_workers=policy.max_active_workers if policy else 1,
        provider_limits=policy.provider_limits if policy else {},
    )


class DatabaseHostCapacityLease:
    def __init__(self, repository, lease: dict[str, Any]) -> None:
        self.repository = repository
        self.token = str(lease["token"])
        self.fencing_token = int(lease["fencing_token"])
        self._closed = False
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._heartbeat_loop,
            name=f"autodev-db-capacity-{self.fencing_token}",
            daemon=True,
        )
        self._thread.start()

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(CAPACITY_HEARTBEAT_INTERVAL_SECONDS):
            try:
                self.repository.heartbeat(
                    self.token,
                    fencing_token=self.fencing_token,
                )
            except Exception:
                continue

    def transition_provider(
        self,
        provider: str,
        *,
        priority: int = 10,
        timeout_seconds: float | None = None,
    ) -> None:
        if not provider:
            self.repository.clear_provider(
                self.token,
                fencing_token=self.fencing_token,
            )
            return
        request = self.repository.request_provider(
            self.token,
            fencing_token=self.fencing_token,
            provider=provider,
            priority=priority,
        )
        request_id = str(request["request_id"])
        deadline = (
            None
            if timeout_seconds is None
            else time.monotonic() + timeout_seconds
        )
        try:
            while True:
                granted = self.repository.try_grant(request_id)
                if granted is not None:
                    return
                if deadline is not None and time.monotonic() >= deadline:
                    raise HostCapacityUnavailable(
                        f"timed out waiting for provider capacity: {provider}"
                    )
                time.sleep(0.2)
        except BaseException:
            try:
                self.repository.cancel(request_id)
            except Exception:
                pass
            raise

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._stop.set()
        self._thread.join(timeout=CAPACITY_HEARTBEAT_INTERVAL_SECONDS * 2)
        self.repository.release(
            self.token,
            fencing_token=self.fencing_token,
        )

    def __enter__(self) -> "DatabaseHostCapacityLease":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


class DatabaseHostCapacityBroker:
    def __init__(
        self,
        policy: HostPolicy,
        *,
        database_config: DatabaseConfig | None = None,
    ) -> None:
        self.policy = policy
        self.database_config = database_config
        self.repository = runtime_capacity_for_policy(
            policy,
            database_config=database_config,
        )

    def acquire(
        self,
        *,
        project_id: str,
        worker_id: str,
        run_id: str,
        provider: str = "",
        resources: list[str] | None = None,
        supervisor_pid: int | None = None,
        timeout_seconds: float | None = None,
        poll_seconds: float = 0.2,
        cancel_requested=None,
    ) -> DatabaseHostCapacityLease:
        from .cutover import enforce_cutover_project

        if not (
            self.database_config is not None
            and self.database_config.allow_sqlite
        ):
            enforce_cutover_project(project_id)
        if self.policy.global_stop_file.exists():
            raise HostCapacityUnavailable("global STOP file is present")
        request_id = secrets.token_urlsafe(18)
        pid = os.getpid()
        supervisor = int(supervisor_pid or pid)
        request = self.repository.request(
            {
                "request_id": request_id,
                "project_id": project_id,
                "worker_id": worker_id,
                "run_id": run_id,
                "kind": "worker",
                "provider": (
                    provider
                    if provider in self.policy.provider_limits
                    else ""
                ),
                "resources": list(resources or []),
                "pid": pid,
                "process_start_identity": process_start_identity(pid),
                "supervisor_pid": supervisor,
                "supervisor_start_identity": process_start_identity(
                    supervisor
                ),
            }
        )
        deadline = (
            None
            if timeout_seconds is None
            else time.monotonic() + timeout_seconds
        )
        try:
            while True:
                if cancel_requested is not None and cancel_requested():
                    raise HostCapacityUnavailable("capacity wait cancelled")
                if self.policy.global_stop_file.exists():
                    raise HostCapacityUnavailable("global STOP file is present")
                granted = self.repository.try_grant(str(request["request_id"]))
                if granted is not None:
                    return DatabaseHostCapacityLease(
                        self.repository, dict(granted)
                    )
                if deadline is not None and time.monotonic() >= deadline:
                    raise HostCapacityUnavailable(
                        "timed out waiting for host capacity"
                    )
                time.sleep(max(poll_seconds, 0.05))
        except BaseException:
            try:
                self.repository.cancel(str(request["request_id"]))
            except Exception:
                pass
            raise

    def snapshot(self, *, persist_reconciliation: bool = False) -> CapacitySnapshot:
        del persist_reconciliation
        value = dict(self.repository.snapshot())
        leases = list(value.get("leases") or [])
        stale = int(value.get("stale") or 0)
        return CapacitySnapshot(
            controlled=bool(value.get("controlled")),
            max_active_workers=int(value.get("max_active_workers") or 0),
            occupied=int(value.get("occupied") or 0),
            live=max(0, len(leases) - stale),
            orphan=0,
            needs_reconcile=stale,
            provider_limits=dict(value.get("provider_limits") or {}),
            provider_occupied=dict(
                value.get("provider_occupied") or {}
            ),
            leases=leases,
            waiters=list(value.get("waiters") or []),
        )


class DatabaseHeartbeatLease:
    def __init__(self, repository, lease: dict[str, Any]) -> None:
        self.repository = repository
        self.token = str(lease["token"])
        self.fencing_token = int(lease["fencing_token"])
        self._stop = threading.Event()
        self._closed = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._heartbeat_loop,
            name=f"autodev-db-heartbeat-{self.fencing_token}",
            daemon=True,
        )
        self._thread.start()

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(CAPACITY_HEARTBEAT_INTERVAL_SECONDS):
            try:
                self.repository.heartbeat(
                    self.token,
                    fencing_token=self.fencing_token,
                )
            except Exception:
                continue

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._stop.set()
        if self._thread is not None:
            self._thread.join(
                timeout=CAPACITY_HEARTBEAT_INTERVAL_SECONDS * 2
            )
        self.repository.release(
            self.token,
            fencing_token=self.fencing_token,
        )


def acquire_database_heartbeat(
    *,
    project_id: str,
    run_id: str,
    kind: str,
    lease_key: str,
    policy: HostPolicy | None,
    database_config: DatabaseConfig | None = None,
) -> DatabaseHeartbeatLease:
    from .cutover import enforce_cutover_project

    if not (
        database_config is not None and database_config.allow_sqlite
    ):
        enforce_cutover_project(project_id)
    repository = runtime_capacity_for_policy(
        policy,
        database_config=database_config,
    )
    pid = os.getpid()
    lease = repository.acquire_runtime(
        {
            "kind": kind,
            "project_id": project_id,
            "lease_key": lease_key,
            "run_id": run_id,
            "pid": pid,
            "process_start_identity": process_start_identity(pid),
        }
    )
    heartbeat = DatabaseHeartbeatLease(repository, dict(lease))
    heartbeat.start()
    return heartbeat


def dispose_runtime_databases() -> None:
    with _LOCK:
        databases = list(_DATABASES.values())
        _DATABASES.clear()
        _READY.clear()
    for database in databases:
        database.dispose()
