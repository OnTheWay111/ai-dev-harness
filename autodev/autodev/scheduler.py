"""Scheduled / conditional auto-trigger for the AutoDev run-loop.

Unattended entrypoint for overnight runs (docs/25 §7 G1, "对标 Multica
Autopilot"). It only starts a run-loop when it is *safe* to do so:

- no ``.autodev/STOP`` file present,
- the queue has a *claimable* pending task (a pending, dependency-ready task
  AND the in_progress budget is not already exhausted — otherwise ``claim_task``
  would raise ``InProgressExistsError`` and starting a loop would just overlap
  the in-flight one / false-succeed),
- and (if configured) the current time is inside the allowed window.

It never bypasses a safety gate: the actual work is delegated to
``controller.run_loop``, which owns the circuit breaker, the
``max_tasks_per_loop`` / ``max_minutes_per_loop`` budgets, and the STOP/STEER
semantics. The trigger also never enables push — it passes the config through
untouched, so ``branch.push`` stays whatever the (push=false by default) config
declares.

Both a dry-run/preview mode (print the decision, start nothing) and a real
mode are provided, plus a ``python -m autodev.scheduler`` CLI so a launchd
job can drive it. Trigger decisions are appended to a jsonl log; when a loop is
actually started, ``run_loop`` emits its own ``loop_start`` / ``loop_summary``
events and notifications.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, time as dtime
import json
from pathlib import Path
import sys
from typing import Any, Callable

from autodev.config import AutoDevConfig, load_autodev_config
from autodev.queue_adapter import QueuePort, create_queue_port
from autodev._internal.io import file_lock, try_file_lock
from autodev.runtime_lease import (
    lease_is_live,
    read_project_loop_lease,
    scheduler_gate_path,
)


# --- time window -----------------------------------------------------------


class ScheduleConfigError(ValueError):
    """Raised when a schedule window / config value cannot be parsed."""


@dataclass(frozen=True)
class TimeWindow:
    """A daily time window, inclusive of ``start`` and exclusive of ``end``.

    Supports overnight windows where ``start > end`` (e.g. ``22:00-06:00``
    spans midnight). ``start == end`` is treated as an always-open window.
    """

    start: dtime
    end: dtime

    @classmethod
    def parse(cls, value: str) -> "TimeWindow":
        text = str(value or "").strip()
        if not text:
            raise ScheduleConfigError("time window is empty")
        if "-" not in text:
            raise ScheduleConfigError(
                f"time window must look like 'HH:MM-HH:MM', got: {value!r}"
            )
        start_raw, end_raw = text.split("-", 1)
        return cls(_parse_hhmm(start_raw), _parse_hhmm(end_raw))

    def contains(self, moment: datetime) -> bool:
        current = moment.time()
        if self.start == self.end:
            return True
        if self.start < self.end:
            return self.start <= current < self.end
        # Overnight window: e.g. 22:00-06:00 -> after start OR before end.
        return current >= self.start or current < self.end

    def label(self) -> str:
        return f"{self.start.strftime('%H:%M')}-{self.end.strftime('%H:%M')}"


def _parse_hhmm(value: str) -> dtime:
    text = str(value or "").strip()
    parts = text.split(":")
    if len(parts) != 2:
        raise ScheduleConfigError(f"time must look like 'HH:MM', got: {value!r}")
    try:
        hour = int(parts[0])
        minute = int(parts[1])
    except ValueError as exc:
        raise ScheduleConfigError(f"time must be numeric 'HH:MM', got: {value!r}") from exc
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ScheduleConfigError(f"time out of range 00:00-23:59, got: {value!r}")
    return dtime(hour=hour, minute=minute)


def window_from_config(config: AutoDevConfig) -> TimeWindow | None:
    """Read an optional ``schedule.window`` from the raw config.

    Absent or empty means "no window restriction" (always in-window).
    """
    schedule = config.raw.get("schedule")
    if not isinstance(schedule, dict):
        return None
    value = schedule.get("window")
    if value in (None, ""):
        return None
    return TimeWindow.parse(str(value))


# --- decision --------------------------------------------------------------


@dataclass(frozen=True)
class TriggerDecision:
    should_trigger: bool
    reason: str
    detail: str
    pending_task_id: str = ""
    stop_present: bool = False
    in_window: bool = True
    window: str = ""
    in_progress_count: int = 0
    checked_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "should_trigger": self.should_trigger,
            "reason": self.reason,
            "detail": self.detail,
            "pending_task_id": self.pending_task_id,
            "stop_present": self.stop_present,
            "in_window": self.in_window,
            "window": self.window,
            "in_progress_count": self.in_progress_count,
            "checked_at": self.checked_at,
        }


def _repo_path(config: AutoDevConfig, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return config.project.repo_root / path


def _stop_file(config: AutoDevConfig) -> Path:
    return _repo_path(config, config.policy.stop_file)


def evaluate_trigger(
    config: AutoDevConfig,
    *,
    now: datetime,
    window: TimeWindow | None = None,
    queue_port: QueuePort | None = None,
) -> TriggerDecision:
    """Decide whether a run-loop should be started right now.

    Pure and side-effect free (does not touch the queue's in_progress state or
    start any loop). Checks, in order: STOP file -> time window -> no in_progress
    over budget -> a claimable pending task. Any single failing condition yields
    ``should_trigger=False`` with a machine-readable ``reason``.

    The in_progress gate matters: ``next_task`` (and hence ``adapter.next()``)
    returns a pending, dependency-ready task *even while another task is
    in_progress*. Triggering then would start a second, overlapping run-loop (or
    one that immediately fails to claim), so the scheduler must mirror
    ``claim_task``'s ``max_in_progress`` gate and skip when it is already full.
    """
    checked_at = now.isoformat(timespec="seconds")
    window_label = window.label() if window else ""

    stop_path = _stop_file(config)
    stop_present = stop_path.exists()
    if stop_present:
        return TriggerDecision(
            should_trigger=False,
            reason="stop_file_present",
            detail=f"STOP file present at {stop_path}; skipping",
            stop_present=True,
            in_window=window.contains(now) if window else True,
            window=window_label,
            checked_at=checked_at,
        )

    in_window = window.contains(now) if window else True
    if not in_window:
        return TriggerDecision(
            should_trigger=False,
            reason="outside_window",
            detail=f"{checked_at} is outside allowed window {window_label}; skipping",
            in_window=False,
            window=window_label,
            checked_at=checked_at,
        )

    adapter = queue_port or create_queue_port(config)

    loop_lease = read_project_loop_lease(config.project.repo_root)
    if lease_is_live(loop_lease, repo_root=config.project.repo_root):
        return TriggerDecision(
            should_trigger=False,
            reason="loop_already_running",
            detail="the project supervisor is already running; it owns worker slot refill",
            in_window=True,
            window=window_label,
            checked_at=checked_at,
        )

    # External/manual claims consume queue capacity. A live project supervisor
    # is handled above; when no supervisor exists we may start one if there is
    # still queue capacity for another exact claim.
    summary = adapter.summary()
    if not summary.ok:
        return TriggerDecision(
            should_trigger=False,
            reason="queue_error",
            detail=f"cannot read queue summary ({summary.status}): {summary.message}",
            in_window=True,
            window=window_label,
            checked_at=checked_at,
        )
    in_progress_ids = list((summary.summary or {}).get("in_progress") or [])
    in_progress_count = len(in_progress_ids)
    max_in_progress = config.queue.max_in_progress
    if in_progress_count >= max_in_progress:
        return TriggerDecision(
            should_trigger=False,
            reason="in_progress_exists",
            detail=(
                f"{in_progress_count} in_progress task(s) {in_progress_ids} at/over "
                f"max_in_progress={max_in_progress}; a loop is already in flight, skipping"
            ),
            in_window=True,
            window=window_label,
            in_progress_count=in_progress_count,
            checked_at=checked_at,
        )

    next_task = adapter.next()
    if not next_task.ok:
        reason = "no_pending_task" if next_task.status == "no_ready_task" else "queue_error"
        detail = next_task.message or next_task.status
        return TriggerDecision(
            should_trigger=False,
            reason=reason,
            detail=f"no claimable pending task ({next_task.status}): {detail}",
            in_window=True,
            window=window_label,
            in_progress_count=in_progress_count,
            checked_at=checked_at,
        )

    pending_id = str((next_task.task or {}).get("id") or "")
    return TriggerDecision(
        should_trigger=True,
        reason="ready",
        detail=f"claimable pending task {pending_id or '(unknown)'}; starting run-loop",
        pending_task_id=pending_id,
        in_window=True,
        window=window_label,
        in_progress_count=in_progress_count,
        checked_at=checked_at,
    )


# --- logging & orchestration ----------------------------------------------


def _scheduler_log_path(config: AutoDevConfig) -> Path:
    return config.project.repo_root / "outputs" / "autodev" / "scheduler" / "trigger.jsonl"


def _log_decision(config: AutoDevConfig, record: dict[str, Any]) -> Path:
    path = _scheduler_log_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(path):
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    return path


@dataclass(frozen=True)
class ScheduleResult:
    triggered: bool
    dry_run: bool
    decision: TriggerDecision
    log_path: Path
    loop_result: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "triggered": self.triggered,
            "dry_run": self.dry_run,
            "decision": self.decision.to_dict(),
            "log_path": str(self.log_path),
            "loop_result": self.loop_result,
        }


def schedule_result_exit_code(result: ScheduleResult) -> int:
    """Map one scheduled trigger result to the shared CLI process contract."""

    if result.loop_result is None:
        # A normal no-trigger decision/dry-run is successful. A trigger that
        # somehow returned no loop result is incomplete and must fail loud.
        return 1 if result.triggered and not result.dry_run else 0
    return 0 if result.loop_result.get("ok") is True else 1


def _run_scheduled_trigger_impl(
    config: AutoDevConfig,
    *,
    now: datetime | None = None,
    window: TimeWindow | None = None,
    dry_run: bool = False,
    max_tasks: int | None = None,
    max_minutes: int | None = None,
    run_id: str = "",
    run_loop_fn: Callable[..., Any] | None = None,
    queue_port: QueuePort | None = None,
) -> ScheduleResult:
    """Evaluate the trigger and, if it fires and not dry-run, start a run-loop.

    The run-loop is invoked through ``controller.run_loop`` (imported lazily to
    avoid an import cycle), so every safety gate — circuit breaker, budgets,
    STOP/STEER, push=false default — is reused rather than re-implemented.
    """
    moment = now or datetime.now()
    if window is None:
        window = window_from_config(config)

    decision = evaluate_trigger(config, now=moment, window=window, queue_port=queue_port)

    record = {
        "event": "schedule_decision",
        "project_id": config.project.id,
        "dry_run": dry_run,
        **decision.to_dict(),
    }

    if not decision.should_trigger:
        log_path = _log_decision(config, record)
        return ScheduleResult(
            triggered=False,
            dry_run=dry_run,
            decision=decision,
            log_path=log_path,
        )

    if dry_run:
        record["event"] = "schedule_decision_dry_run"
        record["would_trigger"] = True
        log_path = _log_decision(config, record)
        return ScheduleResult(
            triggered=False,
            dry_run=True,
            decision=decision,
            log_path=log_path,
        )

    injected_run_loop = run_loop_fn is not None
    if run_loop_fn is None:
        from autodev.controller import run_loop as run_loop_fn  # local import: avoid cycle

    if injected_run_loop:
        result = run_loop_fn(
            config,
            max_tasks=max_tasks,
            max_minutes=max_minutes,
            run_id=run_id,
        )
    else:
        result = run_loop_fn(
            config,
            max_tasks=max_tasks,
            max_minutes=max_minutes,
            run_id=run_id,
            queue_port=queue_port,
        )
    loop_result = result.to_dict() if hasattr(result, "to_dict") else None
    record["event"] = "schedule_triggered"
    record["loop_run_id"] = getattr(result, "run_id", "")
    record["loop_status"] = getattr(result, "status", "")
    log_path = _log_decision(config, record)
    return ScheduleResult(
        triggered=True,
        dry_run=False,
        decision=decision,
        log_path=log_path,
        loop_result=loop_result,
    )


def run_scheduled_trigger(
    config: AutoDevConfig,
    *,
    now: datetime | None = None,
    window: TimeWindow | None = None,
    dry_run: bool = False,
    max_tasks: int | None = None,
    max_minutes: int | None = None,
    run_id: str = "",
    run_loop_fn: Callable[..., Any] | None = None,
    queue_port: QueuePort | None = None,
) -> ScheduleResult:
    """Serialize each project's real trigger decision through loop entry."""
    if dry_run:
        return _run_scheduled_trigger_impl(
            config,
            now=now,
            window=window,
            dry_run=True,
            max_tasks=max_tasks,
            max_minutes=max_minutes,
            run_id=run_id,
            run_loop_fn=run_loop_fn,
            queue_port=queue_port,
        )
    with try_file_lock(scheduler_gate_path(config.project.repo_root)) as acquired:
        if not acquired:
            moment = now or datetime.now()
            selected_window = window if window is not None else window_from_config(config)
            decision = TriggerDecision(
                should_trigger=False,
                reason="trigger_in_progress",
                detail="another scheduler trigger owns this project's entry gate; skipping",
                in_window=selected_window.contains(moment) if selected_window else True,
                window=selected_window.label() if selected_window else "",
                checked_at=moment.isoformat(timespec="seconds"),
            )
            record = {
                "event": "schedule_decision",
                "project_id": config.project.id,
                "dry_run": False,
                **decision.to_dict(),
            }
            return ScheduleResult(
                triggered=False,
                dry_run=False,
                decision=decision,
                log_path=_log_decision(config, record),
            )
        return _run_scheduled_trigger_impl(
            config,
            now=now,
            window=window,
            dry_run=False,
            max_tasks=max_tasks,
            max_minutes=max_minutes,
            run_id=run_id,
            run_loop_fn=run_loop_fn,
            queue_port=queue_port,
        )


# --- CLI -------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="AutoDev run-loop scheduled/conditional auto-trigger",
    )
    parser.add_argument("--project", default="", help="Config path; defaults to AUTODEV_CONFIG, then .autodev/project.yaml found upward from cwd, then XDG")
    parser.add_argument(
        "--window",
        default="",
        help="Allowed time window 'HH:MM-HH:MM' (overrides schedule.window; empty=always)",
    )
    parser.add_argument("--run-id", default="", help="Loop run id; defaults to timestamp")
    parser.add_argument("--max-tasks", type=int, default=0, help="Max final tasks for the loop")
    parser.add_argument("--max-minutes", type=int, default=0, help="Max minutes for the loop")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only print whether it would trigger and why; do not start a loop",
    )
    parser.add_argument(
        "--now",
        default="",
        help="ISO timestamp override for the trigger check (mainly for testing)",
    )
    parser.add_argument("--json", action="store_true", help="Print machine-readable result")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        config = load_autodev_config(args.project)
        window: TimeWindow | None
        if args.window:
            window = TimeWindow.parse(args.window)
        else:
            window = window_from_config(config)
        now = datetime.fromisoformat(args.now) if args.now else datetime.now()
        result = run_scheduled_trigger(
            config,
            now=now,
            window=window,
            dry_run=args.dry_run,
            max_tasks=args.max_tasks or None,
            max_minutes=args.max_minutes or None,
            run_id=args.run_id,
        )
    except Exception as exc:  # noqa: BLE001 - surface a readable CLI error
        print(str(exc), file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2, sort_keys=True))
    else:
        decision = result.decision
        print(f"should_trigger: {decision.should_trigger}")
        print(f"reason: {decision.reason}")
        print(f"detail: {decision.detail}")
        print(f"triggered: {result.triggered}")
        print(f"dry_run: {result.dry_run}")
        print(f"log: {result.log_path}")
        if result.loop_result:
            print(f"loop_status: {result.loop_result.get('status')}")
            print(f"loop_run_id: {result.loop_result.get('run_id')}")
    return schedule_result_exit_code(result)


if __name__ == "__main__":
    raise SystemExit(main())
