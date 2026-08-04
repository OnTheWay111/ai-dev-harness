"""Cross-project worker/provider/resource capacity leases.

The broker is deliberately file-backed: every process participates through one
XDG state document protected by an advisory lock.  It is not a daemon and it
does not own project queue or Git state.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import os
from pathlib import Path
import secrets
import subprocess
import threading
import time
from typing import Any, Callable, Mapping

import yaml

from autodev._internal.io import atomic_write_text, file_lock
from autodev._internal.time import now_iso


CAPACITY_HEARTBEAT_INTERVAL_SECONDS = 5.0
CAPACITY_STALE_SECONDS = 30.0
XDG_CONFIG_HOME_ENV = "XDG_CONFIG_HOME"
XDG_STATE_HOME_ENV = "XDG_STATE_HOME"


class HostCapacityError(RuntimeError):
    """Base error for host capacity policy/state failures."""


class HostCapacityUnavailable(HostCapacityError):
    """Raised when a bounded capacity wait expires."""


@dataclass(frozen=True)
class HostPolicy:
    path: Path
    max_active_workers: int
    provider_limits: dict[str, int]
    fairness: str
    global_stop_file: Path


@dataclass(frozen=True)
class CapacitySnapshot:
    controlled: bool
    max_active_workers: int
    occupied: int
    live: int
    orphan: int
    needs_reconcile: int
    provider_limits: dict[str, int]
    provider_occupied: dict[str, int]
    leases: list[dict[str, Any]]
    waiters: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "controlled": self.controlled,
            "max_active_workers": self.max_active_workers,
            "occupied": self.occupied,
            "live": self.live,
            "orphan": self.orphan,
            "needs_reconcile": self.needs_reconcile,
            "provider_limits": dict(self.provider_limits),
            "provider_occupied": dict(self.provider_occupied),
            "leases": [dict(item) for item in self.leases],
            "waiters": [dict(item) for item in self.waiters],
        }


def _xdg_home(env: Mapping[str, str], key: str, fallback: str) -> Path:
    configured = str(env.get(key) or "").strip()
    if configured:
        return Path(os.path.expandvars(configured)).expanduser()
    home = str(env.get("HOME") or "").strip()
    base = Path(home).expanduser() if home else Path.home()
    return base / fallback


def default_host_policy_path(env: Mapping[str, str] | None = None) -> Path:
    env_map = os.environ if env is None else env
    return _xdg_home(env_map, XDG_CONFIG_HOME_ENV, ".config") / "autodev" / "host.yaml"


def default_capacity_state_path(env: Mapping[str, str] | None = None) -> Path:
    env_map = os.environ if env is None else env
    return (
        _xdg_home(env_map, XDG_STATE_HOME_ENV, ".local/state")
        / "autodev"
        / "runtime"
        / "capacity.json"
    )


def _positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise HostCapacityError(f"{label} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise HostCapacityError(f"{label} must be a positive integer") from exc
    if parsed <= 0:
        raise HostCapacityError(f"{label} must be a positive integer")
    return parsed


def load_host_policy(
    path: str | Path | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> HostPolicy | None:
    env_map = os.environ if env is None else env
    selected = Path(path).expanduser() if path else default_host_policy_path(env_map)
    if not selected.exists():
        return None
    try:
        payload = yaml.safe_load(selected.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise HostCapacityError(f"cannot read host capacity policy: {selected}") from exc
    if not isinstance(payload, dict):
        raise HostCapacityError("host capacity policy must be a mapping")
    if payload.get("schema_version", 1) != 1:
        raise HostCapacityError("unsupported host capacity schema_version")
    host = payload.get("host") or {}
    if not isinstance(host, dict):
        raise HostCapacityError("host capacity policy host must be a mapping")
    limits_raw = host.get("provider_limits") or {}
    if not isinstance(limits_raw, dict):
        raise HostCapacityError("host.provider_limits must be a mapping")
    limits: dict[str, int] = {}
    for raw_name, raw_limit in limits_raw.items():
        name = str(raw_name).strip()
        if not name:
            raise HostCapacityError("host.provider_limits contains an empty provider")
        limits[name] = _positive_int(raw_limit, f"host.provider_limits.{name}")
    fairness = str(host.get("fairness") or "fifo_per_project").strip()
    if fairness != "fifo_per_project":
        raise HostCapacityError("host.fairness must be fifo_per_project")
    raw_stop = str(host.get("global_stop_file") or "~/.config/autodev/STOP")
    global_stop = Path(os.path.expandvars(raw_stop)).expanduser()
    return HostPolicy(
        path=selected.resolve(strict=False),
        max_active_workers=_positive_int(
            host.get("max_active_workers", 1), "host.max_active_workers"
        ),
        provider_limits=limits,
        fairness=fairness,
        global_stop_file=global_stop.resolve(strict=False),
    )


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


def process_start_identity(pid: int) -> str:
    """Return an OS process-start identity when the platform can prove it."""
    if pid <= 0:
        return ""
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _heartbeat_age(value: Any) -> float | None:
    try:
        heartbeat = datetime.fromisoformat(str(value or ""))
    except ValueError:
        return None
    if heartbeat.tzinfo is None:
        heartbeat = heartbeat.astimezone()
    return abs((datetime.now().astimezone() - heartbeat).total_seconds())


def _empty_state() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "leases": [],
        "waiters": [],
        "last_granted_project": "",
    }


class HostCapacityBroker:
    """Atomic host worker/provider/resource allocator."""

    def __init__(self, policy: HostPolicy, *, state_path: Path | None = None):
        self.policy = policy
        self.state_path = (state_path or default_capacity_state_path()).resolve(strict=False)

    def _read_unlocked(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return _empty_state()
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise HostCapacityError(f"invalid capacity state: {self.state_path}") from exc
        if not isinstance(payload, dict) or payload.get("schema_version") != 1:
            raise HostCapacityError("invalid capacity state schema")
        if not isinstance(payload.get("leases"), list) or not isinstance(
            payload.get("waiters"), list
        ):
            raise HostCapacityError("capacity leases/waiters must be lists")
        return payload

    def _write_unlocked(self, state: dict[str, Any]) -> None:
        state["schema_version"] = 1
        state["updated_at"] = now_iso()
        atomic_write_text(
            self.state_path,
            json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )

    def _reconcile_unlocked(self, state: dict[str, Any]) -> None:
        retained: list[dict[str, Any]] = []
        for raw in state.get("leases", []):
            if not isinstance(raw, dict):
                continue
            lease = dict(raw)
            try:
                pid = int(lease.get("pid") or 0)
            except (TypeError, ValueError):
                pid = 0
            if not _pid_alive(pid):
                continue
            recorded_identity = str(lease.get("process_start_identity") or "")
            current_identity = process_start_identity(pid)
            if recorded_identity and current_identity and recorded_identity != current_identity:
                continue
            age = _heartbeat_age(lease.get("heartbeat_at"))
            if age is None or age > CAPACITY_STALE_SECONDS:
                lease["status"] = "needs_reconcile"
            else:
                supervisor_pid = int(lease.get("supervisor_pid") or 0)
                supervisor_identity = str(
                    lease.get("supervisor_start_identity") or ""
                )
                current_supervisor_identity = process_start_identity(supervisor_pid)
                supervisor_reused = bool(
                    supervisor_identity
                    and current_supervisor_identity
                    and supervisor_identity != current_supervisor_identity
                )
                if not _pid_alive(supervisor_pid) or supervisor_reused:
                    lease["status"] = "orphan"
                else:
                    lease["status"] = "live"
            retained.append(lease)
        state["leases"] = retained

        waiters: list[dict[str, Any]] = []
        for raw in state.get("waiters", []):
            if not isinstance(raw, dict):
                continue
            waiter = dict(raw)
            try:
                pid = int(waiter.get("pid") or 0)
            except (TypeError, ValueError):
                continue
            if not _pid_alive(pid):
                continue
            recorded_identity = str(waiter.get("process_start_identity") or "")
            current_identity = process_start_identity(pid)
            if recorded_identity and current_identity and recorded_identity != current_identity:
                continue
            age = _heartbeat_age(waiter.get("heartbeat_at"))
            if age is not None and age <= CAPACITY_STALE_SECONDS:
                waiters.append(waiter)
        state["waiters"] = waiters

    def _provider_available(self, state: dict[str, Any], provider: str) -> bool:
        if not provider:
            return True
        limit = self.policy.provider_limits.get(provider)
        if limit is None:
            return True
        occupied = sum(
            1 for lease in state["leases"] if str(lease.get("provider") or "") == provider
        )
        return occupied < limit

    @staticmethod
    def _resources_available(state: dict[str, Any], resources: list[str]) -> bool:
        occupied = {
            str(resource)
            for lease in state["leases"]
            for resource in lease.get("resources", []) or []
        }
        return not occupied.intersection(resources)

    def _allocatable(self, state: dict[str, Any], waiter: dict[str, Any]) -> bool:
        if len(state["leases"]) >= self.policy.max_active_workers:
            return False
        return self._provider_available(
            state, str(waiter.get("provider") or "")
        ) and self._resources_available(
            state, [str(item) for item in waiter.get("resources", []) or []]
        )

    def _selected_waiter(self, state: dict[str, Any]) -> str:
        heads: dict[str, dict[str, Any]] = {}
        for waiter in sorted(
            state["waiters"],
            key=lambda item: (str(item.get("requested_at") or ""), str(item.get("request_id") or "")),
        ):
            project_id = str(waiter.get("project_id") or "")
            heads.setdefault(project_id, waiter)
        projects = sorted(heads)
        if not projects:
            return ""
        last = str(state.get("last_granted_project") or "")
        if last in projects:
            pivot = projects.index(last) + 1
            projects = projects[pivot:] + projects[:pivot]
        for project_id in projects:
            waiter = heads[project_id]
            if self._allocatable(state, waiter):
                return str(waiter.get("request_id") or "")
        return ""

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
        cancel_requested: Callable[[], bool] | None = None,
    ) -> "HostCapacityLease":
        normalized_resources = sorted({str(item).strip() for item in resources or [] if str(item).strip()})
        if self.policy.global_stop_file.exists():
            raise HostCapacityUnavailable("global STOP file is present")
        request_id = secrets.token_urlsafe(18)
        pid = os.getpid()
        started = process_start_identity(pid)
        supervisor = int(supervisor_pid or pid)
        waiter = {
            "request_id": request_id,
            "project_id": project_id,
            "worker_id": worker_id,
            "run_id": run_id,
            "provider": provider if provider in self.policy.provider_limits else "",
            "resources": normalized_resources,
            "pid": pid,
            "process_start_identity": started,
            "requested_at": now_iso(),
            "heartbeat_at": now_iso(),
        }
        deadline = None if timeout_seconds is None else time.monotonic() + timeout_seconds
        try:
            while True:
                if cancel_requested is not None and cancel_requested():
                    raise HostCapacityUnavailable("capacity wait cancelled")
                if self.policy.global_stop_file.exists():
                    raise HostCapacityUnavailable("global STOP file is present")
                with file_lock(self.state_path):
                    state = self._read_unlocked()
                    self._reconcile_unlocked(state)
                    current = next(
                        (
                            item
                            for item in state["waiters"]
                            if item.get("request_id") == request_id
                        ),
                        None,
                    )
                    if current is None:
                        state["waiters"].append(dict(waiter))
                    else:
                        current["heartbeat_at"] = now_iso()
                    selected = self._selected_waiter(state)
                    if selected == request_id:
                        token = secrets.token_urlsafe(24)
                        lease = {
                            "token": token,
                            "project_id": project_id,
                            "worker_id": worker_id,
                            "run_id": run_id,
                            "provider": waiter["provider"],
                            "resources": normalized_resources,
                            "pid": pid,
                            "process_start_identity": started,
                            "supervisor_pid": supervisor,
                            "supervisor_start_identity": process_start_identity(supervisor),
                            "status": "live",
                            "acquired_at": now_iso(),
                            "heartbeat_at": now_iso(),
                        }
                        state["leases"].append(lease)
                        state["waiters"] = [
                            item
                            for item in state["waiters"]
                            if item.get("request_id") != request_id
                        ]
                        state["last_granted_project"] = project_id
                        self._write_unlocked(state)
                        return HostCapacityLease(self, token)
                    self._write_unlocked(state)
                if deadline is not None and time.monotonic() >= deadline:
                    raise HostCapacityUnavailable("timed out waiting for host capacity")
                time.sleep(max(poll_seconds, 0.05))
        except BaseException:
            self.cancel_waiter(request_id)
            raise

    def cancel_waiter(self, request_id: str) -> None:
        with file_lock(self.state_path):
            state = self._read_unlocked()
            self._reconcile_unlocked(state)
            state["waiters"] = [
                item for item in state["waiters"] if item.get("request_id") != request_id
            ]
            self._write_unlocked(state)

    def heartbeat(self, token: str) -> bool:
        with file_lock(self.state_path):
            state = self._read_unlocked()
            self._reconcile_unlocked(state)
            for lease in state["leases"]:
                if lease.get("token") == token:
                    lease["heartbeat_at"] = now_iso()
                    if lease.get("status") == "needs_reconcile":
                        lease["status"] = "live"
                    self._write_unlocked(state)
                    return True
            self._write_unlocked(state)
            return False

    def transition_provider(
        self,
        token: str,
        provider: str,
        *,
        priority: int = 10,
        timeout_seconds: float | None = None,
        poll_seconds: float = 0.2,
    ) -> None:
        normalized = provider if provider in self.policy.provider_limits else ""
        deadline = None if timeout_seconds is None else time.monotonic() + timeout_seconds
        while True:
            with file_lock(self.state_path):
                state = self._read_unlocked()
                self._reconcile_unlocked(state)
                target = next(
                    (lease for lease in state["leases"] if lease.get("token") == token),
                    None,
                )
                if target is None:
                    raise HostCapacityError("capacity lease is no longer active")
                current = str(target.get("provider") or "")
                if current == normalized:
                    target.pop("phase", None)
                    target.pop("requested_provider", None)
                    target.pop("provider_priority", None)
                    target.pop("provider_requested_at", None)
                    self._write_unlocked(state)
                    return
                target["provider"] = ""
                if not normalized:
                    target.pop("phase", None)
                    target.pop("requested_provider", None)
                    target.pop("provider_priority", None)
                    target.pop("provider_requested_at", None)
                    target["heartbeat_at"] = now_iso()
                    self._write_unlocked(state)
                    return
                if str(target.get("requested_provider") or "") != normalized:
                    target["requested_provider"] = normalized
                    target["provider_priority"] = int(priority)
                    target["provider_requested_at"] = now_iso()
                target["phase"] = "waiting_provider"
                contenders = sorted(
                    (
                        lease
                        for lease in state["leases"]
                        if lease.get("phase") == "waiting_provider"
                        and str(lease.get("requested_provider") or "") == normalized
                    ),
                    key=lambda lease: (
                        int(
                            10
                            if lease.get("provider_priority") is None
                            else lease.get("provider_priority")
                        ),
                        str(lease.get("provider_requested_at") or ""),
                        str(lease.get("token") or ""),
                    ),
                )
                selected = str(contenders[0].get("token") or "") if contenders else ""
                if selected == token and self._provider_available(state, normalized):
                    target["provider"] = normalized
                    target.pop("phase", None)
                    target.pop("requested_provider", None)
                    target.pop("provider_priority", None)
                    target.pop("provider_requested_at", None)
                    target["heartbeat_at"] = now_iso()
                    self._write_unlocked(state)
                    return
                self._write_unlocked(state)
            if deadline is not None and time.monotonic() >= deadline:
                raise HostCapacityUnavailable(
                    f"timed out waiting for provider capacity: {normalized}"
                )
            time.sleep(max(poll_seconds, 0.05))

    def release(self, token: str) -> None:
        with file_lock(self.state_path):
            state = self._read_unlocked()
            self._reconcile_unlocked(state)
            state["leases"] = [
                lease for lease in state["leases"] if lease.get("token") != token
            ]
            self._write_unlocked(state)

    def snapshot(self, *, persist_reconciliation: bool = False) -> CapacitySnapshot:
        """Return a reconciled view without turning status readers into writers.

        Dashboard and doctor call this method from read-only paths.  They may
        derive ``orphan``/``needs_reconcile`` from current process facts, but
        must not rewrite the shared runtime file merely because somebody
        refreshed a page.  Mutating broker operations already persist the same
        reconciliation before making their own state change; an explicit
        maintenance caller may opt in with ``persist_reconciliation=True``.
        """
        if persist_reconciliation:
            with file_lock(self.state_path):
                state = self._read_unlocked()
                self._reconcile_unlocked(state)
                self._write_unlocked(state)
        else:
            # Writers publish with atomic ``os.replace``, so a lock-free reader
            # sees either the complete old document or the complete new one.
            # Avoid even creating ``capacity.json.lock`` from Dashboard/doctor.
            state = self._read_unlocked()
            self._reconcile_unlocked(state)
        leases = [dict(item) for item in state["leases"]]
        statuses = [str(item.get("status") or "live") for item in leases]
        provider_occupied = {
            provider: sum(
                1 for lease in leases if str(lease.get("provider") or "") == provider
            )
            for provider in self.policy.provider_limits
        }
        return CapacitySnapshot(
            controlled=True,
            max_active_workers=self.policy.max_active_workers,
            occupied=len(leases),
            live=statuses.count("live"),
            orphan=statuses.count("orphan"),
            needs_reconcile=statuses.count("needs_reconcile"),
            provider_limits=dict(self.policy.provider_limits),
            provider_occupied=provider_occupied,
            leases=leases,
            waiters=[dict(item) for item in state["waiters"]],
        )


class HostCapacityLease:
    """Heartbeat-backed handle for one all-or-nothing capacity group."""

    def __init__(self, broker: HostCapacityBroker, token: str):
        self.broker = broker
        self.token = token
        self._closed = False
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._heartbeat_loop,
            name=f"autodev-capacity-{token[:8]}",
            daemon=True,
        )
        self._thread.start()

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(CAPACITY_HEARTBEAT_INTERVAL_SECONDS):
            try:
                if not self.broker.heartbeat(self.token):
                    return
            except OSError:
                continue

    def transition_provider(
        self,
        provider: str,
        *,
        priority: int = 10,
        timeout_seconds: float | None = None,
    ) -> None:
        self.broker.transition_provider(
            self.token,
            provider,
            priority=priority,
            timeout_seconds=timeout_seconds,
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._stop.set()
        self._thread.join(timeout=CAPACITY_HEARTBEAT_INTERVAL_SECONDS * 2)
        self.broker.release(self.token)

    def __enter__(self) -> "HostCapacityLease":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


def uncontrolled_snapshot() -> CapacitySnapshot:
    return CapacitySnapshot(
        controlled=False,
        max_active_workers=0,
        occupied=0,
        live=0,
        orphan=0,
        needs_reconcile=0,
        provider_limits={},
        provider_occupied={},
        leases=[],
        waiters=[],
    )


def create_host_capacity_broker(policy: HostPolicy):
    """Select the file or database host-capacity composition."""
    from autodev.database.config import MODE_DATABASE
    from autodev.database.shadow import resolve_persistence_config

    persistence = resolve_persistence_config()
    if persistence.mode == MODE_DATABASE:
        from autodev.database.composition import DatabaseHostCapacityBroker

        return DatabaseHostCapacityBroker(
            policy,
            database_config=persistence,
        )
    return HostCapacityBroker(policy)
