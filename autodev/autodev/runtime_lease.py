"""Project/run ownership leases used for exclusion and dashboard truth."""
from __future__ import annotations

from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import secrets
import threading
from typing import Any

from autodev._internal.io import atomic_write_text
from autodev._internal.time import now_iso
from autodev.run_store import validate_run_id


HEARTBEAT_INTERVAL_SECONDS = 5.0
HEARTBEAT_STALE_SECONDS = 30.0


def runtime_root(repo_root: Path) -> Path:
    return Path(repo_root).resolve(strict=False) / ".autodev" / "runtime"


def project_loop_lock_path(repo_root: Path) -> Path:
    return runtime_root(repo_root) / "run-loop.lock"


def project_loop_lease_path(repo_root: Path) -> Path:
    return runtime_root(repo_root) / "run-loop.json"


def scheduler_gate_path(repo_root: Path) -> Path:
    return runtime_root(repo_root) / "scheduler-trigger.lock"


def landing_lane_path(repo_root: Path) -> Path:
    return runtime_root(repo_root) / "landing-lane"


def run_lease_path(repo_root: Path, run_id: str) -> Path:
    return runtime_root(repo_root) / "runs" / f"{validate_run_id(run_id)}.json"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def lease_is_live(
    lease: dict[str, Any],
    *,
    repo_root: Path,
    run_id: str = "",
    now: datetime | None = None,
) -> bool:
    if not lease:
        return False
    expected_root = str(Path(repo_root).resolve(strict=False))
    if str(lease.get("repo_root") or "") != expected_root:
        return False
    lease_run_id = str(lease.get("run_id") or "")
    # A live supervisor is not proof that any particular child worker is
    # alive. Child runs must have their own exact RunHeartbeat; otherwise one
    # dead worker would be displayed as active for as long as the parent loop
    # survives.
    if run_id and lease_run_id != run_id:
        return False
    try:
        heartbeat = datetime.fromisoformat(str(lease.get("heartbeat_at") or ""))
    except ValueError:
        return False
    moment = now or datetime.now().astimezone()
    if heartbeat.tzinfo is None:
        heartbeat = heartbeat.astimezone()
    if abs((moment - heartbeat).total_seconds()) > HEARTBEAT_STALE_SECONDS:
        return False
    try:
        pid = int(lease.get("pid") or 0)
    except (TypeError, ValueError):
        return False
    return _pid_alive(pid)


def read_project_loop_lease(repo_root: Path) -> dict[str, Any]:
    return _read_json(project_loop_lease_path(repo_root))


def run_has_live_lease(repo_root: Path, run_id: str) -> bool:
    run_id = validate_run_id(run_id)
    exact = _read_json(run_lease_path(repo_root, run_id))
    if lease_is_live(exact, repo_root=repo_root, run_id=run_id):
        return True
    loop = read_project_loop_lease(repo_root)
    return lease_is_live(loop, repo_root=repo_root, run_id=run_id)


class _HeartbeatLease:
    def __init__(self, path: Path, *, repo_root: Path, project_id: str, run_id: str, kind: str):
        self.path = path
        self.repo_root = Path(repo_root).resolve(strict=False)
        self.project_id = project_id
        self.run_id = validate_run_id(run_id)
        self.kind = kind
        self.token = secrets.token_urlsafe(18)
        self.started_at = now_iso()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _payload(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "kind": self.kind,
            "project_id": self.project_id,
            "repo_root": str(self.repo_root),
            "run_id": self.run_id,
            "pid": os.getpid(),
            "token": self.token,
            "started_at": self.started_at,
            "heartbeat_at": now_iso(),
        }

    def _write(self) -> None:
        atomic_write_text(
            self.path,
            json.dumps(self._payload(), ensure_ascii=False, sort_keys=True) + "\n",
        )

    def start(self) -> None:
        self._write()
        self._thread = threading.Thread(
            target=self._heartbeat_loop,
            name=f"autodev-heartbeat-{self.run_id}",
            daemon=True,
        )
        self._thread.start()

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(HEARTBEAT_INTERVAL_SECONDS):
            try:
                self._write()
            except OSError:
                # The owner remains authoritative through its process/lock;
                # dashboard will fail closed to stale if heartbeats cannot land.
                continue

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=HEARTBEAT_INTERVAL_SECONDS * 2)
        current = _read_json(self.path)
        if current.get("token") == self.token:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass


class RunHeartbeat:
    """Per-run PID/heartbeat identity; it does not serialize independent runs."""

    def __init__(self, repo_root: Path, project_id: str, run_id: str):
        from autodev.database.config import MODE_DATABASE
        from autodev.database.shadow import resolve_persistence_config

        persistence = resolve_persistence_config()
        if persistence.mode == MODE_DATABASE:
            from autodev.database.composition import (
                acquire_database_heartbeat,
            )
            from autodev.host_capacity import load_host_policy

            self._lease = acquire_database_heartbeat(
                project_id=project_id,
                run_id=run_id,
                kind="run",
                lease_key=f"run:{project_id}:{run_id}",
                policy=load_host_policy(),
                database_config=persistence,
            )
            self._started = True
        else:
            self._lease = _HeartbeatLease(
                run_lease_path(repo_root, run_id),
                repo_root=repo_root,
                project_id=project_id,
                run_id=run_id,
                kind="run",
            )
            self._started = False

    def __enter__(self) -> "RunHeartbeat":
        if not self._started:
            self._lease.start()
            self._started = True
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self._lease.close()


class ProjectLoopLease:
    """Non-blocking same-project run-loop mutex plus PID heartbeat identity."""

    def __init__(self, handle: Any, heartbeat: _HeartbeatLease):
        self._handle = handle
        self._heartbeat = heartbeat

    @classmethod
    def try_acquire(cls, repo_root: Path, project_id: str, run_id: str) -> "ProjectLoopLease | None":
        from autodev.database.config import MODE_DATABASE
        from autodev.database.shadow import resolve_persistence_config

        persistence = resolve_persistence_config()
        if persistence.mode == MODE_DATABASE:
            from autodev.database.composition import (
                acquire_database_heartbeat,
            )
            from autodev.host_capacity import load_host_policy
            from autodev.database.runtime_repository import (
                RuntimeLeaseAlreadyActiveError,
            )

            try:
                heartbeat = acquire_database_heartbeat(
                    project_id=project_id,
                    run_id=run_id,
                    kind="supervisor",
                    lease_key=f"supervisor:{project_id}",
                    policy=load_host_policy(),
                    database_config=persistence,
                )
            except RuntimeLeaseAlreadyActiveError:
                return None
            return _DatabaseProjectLoopLease(heartbeat)
        lock_path = project_loop_lock_path(repo_root)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = lock_path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
            return None
        heartbeat = _HeartbeatLease(
            project_loop_lease_path(repo_root),
            repo_root=repo_root,
            project_id=project_id,
            run_id=run_id,
            kind="run_loop",
        )
        try:
            heartbeat.start()
        except BaseException:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()
            raise
        return cls(handle, heartbeat)

    def __enter__(self) -> "ProjectLoopLease":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self._heartbeat.close()
        fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        self._handle.close()


class _DatabaseProjectLoopLease:
    def __init__(self, heartbeat: Any) -> None:
        self._heartbeat = heartbeat

    def __enter__(self) -> "_DatabaseProjectLoopLease":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self._heartbeat.close()
