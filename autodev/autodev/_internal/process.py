"""Subprocess execution with whole-process-group timeout/cancel cleanup."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import signal
import subprocess
import time


@dataclass(frozen=True)
class ProcessGroupResult:
    returncode: int | None
    stdout: str
    stderr: str
    timed_out: bool = False


def _group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Darwin may report EPERM for a group whose only remaining member is
        # the just-terminated zombie leader. There is no live child we can
        # signal in that state, so do not spin or turn timeout cleanup into an
        # unrelated launch error.
        return False
    return True


def terminate_process_group(
    process: subprocess.Popen[str],
    *,
    grace_seconds: float = 0.25,
) -> None:
    """TERM, briefly wait, then KILL the isolated session led by ``process``."""
    process_group_id = process.pid
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass

    deadline = time.monotonic() + max(0.0, grace_seconds)
    while _group_exists(process_group_id) and time.monotonic() < deadline:
        time.sleep(0.02)
    if _group_exists(process_group_id):
        try:
            os.killpg(process_group_id, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    try:
        process.wait(timeout=max(0.1, grace_seconds))
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        process.wait()


def run_process_group(
    command: list[str],
    *,
    cwd: Path,
    timeout_seconds: int | float,
    stdin: str | None = None,
    term_grace_seconds: float = 0.25,
) -> ProcessGroupResult:
    """Run one command in a new session and clean its descendants on timeout/cancel."""
    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        stdin=subprocess.PIPE if stdin is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(input=stdin, timeout=timeout_seconds)
        return ProcessGroupResult(
            returncode=process.returncode,
            stdout=stdout or "",
            stderr=stderr or "",
        )
    except subprocess.TimeoutExpired:
        terminate_process_group(process, grace_seconds=term_grace_seconds)
        stdout, stderr = process.communicate()
        return ProcessGroupResult(
            returncode=None,
            stdout=stdout or "",
            stderr=stderr or "",
            timed_out=True,
        )
    except BaseException:
        terminate_process_group(process, grace_seconds=term_grace_seconds)
        try:
            process.communicate(timeout=1)
        except BaseException:
            pass
        raise
