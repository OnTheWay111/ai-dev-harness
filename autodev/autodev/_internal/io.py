"""Cross-process file locking and atomic YAML writes."""
from __future__ import annotations

from collections.abc import Callable
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import tempfile
from typing import Any, Iterator, TypeVar

import yaml


T = TypeVar("T")


def lock_path_for(target: Path) -> Path:
    return target.with_name(f"{target.name}.lock")


@contextmanager
def file_lock(target: Path) -> Iterator[None]:
    """Hold an advisory cross-process lock for ``target`` updates."""
    lock_path = lock_path_for(target)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def try_file_lock(target: Path) -> Iterator[bool]:
    """Try a cross-process lock once, yielding False instead of blocking."""
    lock_path = lock_path_for(target)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def atomic_write_text(target: Path, text: str) -> None:
    """Durably replace a text file using a sibling temporary file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, target)
        # ``os.replace`` makes the rename atomic, but a crash can still lose
        # the new directory entry unless the containing directory is synced.
        directory_fd = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def dump_yaml(data: Any) -> str:
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False)


def atomic_write_yaml(target: Path, data: Any) -> None:
    atomic_write_text(target, dump_yaml(data))


def locked_write_yaml(target: Path, data: Any) -> None:
    with file_lock(target):
        atomic_write_yaml(target, data)


def mutate_yaml(
    target: Path,
    mutate: Callable[[dict[str, Any]], T],
    *,
    default: dict[str, Any] | None = None,
) -> T:
    """Read, mutate, and atomically persist one YAML mapping under one lock."""
    with file_lock(target):
        if target.exists():
            loaded = yaml.safe_load(target.read_text(encoding="utf-8")) or {}
            if not isinstance(loaded, dict):
                raise ValueError(f"YAML root must be a mapping: {target}")
            data = loaded
        else:
            data = dict(default or {})
        result = mutate(data)
        atomic_write_yaml(target, data)
        return result
