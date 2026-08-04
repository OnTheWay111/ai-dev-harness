"""Spawn-safe child worker entry point for parallel project supervisors."""
from __future__ import annotations

import json
import os
from pathlib import Path
import traceback

from autodev._internal.io import atomic_write_text
from autodev.config import AutoDevConfig


def run_assigned_task(
    config: AutoDevConfig,
    *,
    task_id: str,
    run_id: str,
    steer_text: str,
    retry_context: str,
    retry_from_run_id: str,
    result_path: Path,
    supervisor_pid: int,
    capacity_cancel_event: object | None = None,
) -> None:
    """Run one exact task and durably return a machine-readable result."""
    from autodev.controller import ControllerResult, run_one

    try:
        result = run_one(
            config,
            task_id=task_id,
            run_id=run_id,
            steer_text=steer_text,
            retry_context=retry_context,
            retry_from_run_id=retry_from_run_id,
            supervisor_pid=supervisor_pid,
            defer_landing=True,
            capacity_cancel_event=capacity_cancel_event,
        )
    except BaseException as exc:
        result = ControllerResult(
            ok=False,
            status="worker_process_error",
            message=f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}",
            run_id=run_id,
            task_id=task_id,
        )
    payload = result.to_dict()
    payload["worker_pid"] = os.getpid()
    atomic_write_text(
        result_path,
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
