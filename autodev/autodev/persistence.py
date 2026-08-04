"""Backend-neutral persistence contracts for AutoDev lifecycle state.

This module deliberately has no SQLAlchemy imports.  File-mode consumers can
install the base wheel without the optional ``postgres`` extra, while the core
controller can depend on these contracts rather than a storage implementation.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol, TypeVar, runtime_checkable


T = TypeVar("T")


class PersistenceError(RuntimeError):
    """Base class for durable-state failures."""


class PersistenceConfigurationError(PersistenceError):
    """The selected backend is missing or unsafe configuration."""


class PersistenceUnavailableError(PersistenceError):
    """The configured durable store cannot be reached."""


class PersistenceConflictError(PersistenceError):
    """A version, lease, or fencing precondition no longer matches."""


class PersistenceNotFoundError(PersistenceError):
    """A requested durable entity does not exist."""


@runtime_checkable
class RunStorePort(Protocol):
    def create(self, run_id: str, initial: Mapping[str, Any]) -> Mapping[str, Any]: ...
    def load(self, run_id: str) -> Mapping[str, Any]: ...
    def mutate(
        self,
        run_id: str,
        mutate: Callable[[dict[str, Any]], T],
        *,
        expected_version: int | None = None,
    ) -> tuple[Mapping[str, Any], T]: ...
    def mutate_with_event(
        self,
        run_id: str,
        mutate: Callable[[dict[str, Any]], T],
        *,
        expected_version: int | None = None,
        event: Mapping[str, Any] | None,
    ) -> tuple[Mapping[str, Any], T]: ...
    def append_event(self, run_id: str, event: Mapping[str, Any]) -> Mapping[str, Any]: ...
    def list_recent(self, *, limit: int = 50, cursor: str = "") -> Sequence[Mapping[str, Any]]: ...


@runtime_checkable
class ArtifactStorePort(Protocol):
    def write(self, relative_path: str, content: bytes) -> tuple[str, str, int]: ...
    def read(self, uri: str) -> bytes: ...
    def resolve_local_path(self, uri: str) -> Path | None: ...


@runtime_checkable
class ArtifactIndexPort(Protocol):
    def index_file(
        self,
        run_id: str,
        path: str | Path,
        *,
        task_id: str = "",
        logical_name: str = "",
        kind: str = "artifact",
    ) -> Mapping[str, Any]: ...


@runtime_checkable
class RuntimeLeasePort(Protocol):
    def acquire(self, request: Mapping[str, Any]) -> Mapping[str, Any]: ...
    def heartbeat(self, token: str, *, fencing_token: int) -> Mapping[str, Any]: ...
    def release(self, token: str, *, fencing_token: int) -> None: ...


@runtime_checkable
class CapacityPort(Protocol):
    def request(self, request: Mapping[str, Any]) -> Mapping[str, Any]: ...
    def snapshot(self) -> Mapping[str, Any]: ...
    def cancel(self, request_id: str) -> None: ...


@runtime_checkable
class LandingStorePort(Protocol):
    def prepare(self, record: Mapping[str, Any]) -> Mapping[str, Any]: ...
    def advance(
        self,
        project_id: str,
        task_id: str,
        run_id: str,
        *,
        expected_status: str,
        new_status: str,
        changes: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]: ...
    def pending(self, project_id: str) -> Sequence[Mapping[str, Any]]: ...
