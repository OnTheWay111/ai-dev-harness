"""Single-task AutoDev controller."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
import json
import multiprocessing
import os
from pathlib import Path
import secrets
import shlex
import shutil
import sys
import time
from typing import Any

import yaml

from autodev.adapters.queue_yaml import load_queue
from autodev.agent_session import (
    BuilderInvocation,
    build_builder_invocation,
    decode_builder_output,
    retry_session_candidate,
    session_capability,
)
from autodev.agent_selection import AgentSelection, AgentSelectionError, resolve_agent_selection
from autodev.config import AgentCommandConfig, AutoDevConfig, load_autodev_config
from autodev.context_sharing import latest_handoff_excerpt, write_loop_handoff, write_task_handoff
from autodev.direction_review import write_direction_review_artifacts
from autodev.evaluator import run_evaluator_gate
from autodev.git_worktree import (
    advance_integration_ref,
    AutoDevGitError,
    WorktreeContext,
    commit_candidate_checkpoint,
    commit_checkpoint,
    prepare_worktree,
)
from autodev.host_capacity import (
    HostCapacityError,
    HostCapacityLease,
    HostCapacityUnavailable,
    create_host_capacity_broker,
    load_host_policy,
)
from autodev.notifications import dispatch_autodev_notification, validate_notifications_config
from autodev.agent_permissions import build_agent_argv
from autodev.policy import check_project_safety_policy
from autodev.queue_adapter import QueueOperationResult, QueuePort, create_queue_port
from autodev.run_store import (
    append_event,
    create_run,
    load_run,
    mutate_run,
    run_paths,
    validate_run_id,
    validate_task_id,
    write_conclusion_artifact,
)
from autodev.runtime_lease import ProjectLoopLease, RunHeartbeat, landing_lane_path
from autodev.verify import run_verify_gate, task_contract_drift, verify_commands_for_task
from autodev._internal.io import atomic_write_text, file_lock
from autodev._internal.process import run_process_group


PROMPT_TEMPLATE = "docs/AUTODEV_PROMPT.md"
RESULT_PREFIX = "AUTODEV_RESULT:"

# Loop-terminal statuses that must NOT be retried by run_loop (H-446): the failure is
# an operational precondition, not builder work — e.g. the pending task was never
# committed to base_ref, so the worktree (built from base_ref) can't contain it.
# Retrying in place cannot fix it; the loop must fail loud and stop, not schedule a
# retry / count it as a task block (which previously bubbled up as retry_resume_failed).
_NON_RETRYABLE_LOOP_STATUSES = frozenset(
    {
        "queue_not_committed_to_base",
        "workspace_queue_stale",
        "cancelled_by_breaker",
        "landing_finalize_pending",
        "in_progress_exists",
        "global_stop_file",
    }
)

# H-445 (docs/25 §7 G2): classify a run-one failure by nature so run_loop only spends a
# fresh-session retry on failures a retry can plausibly fix.
#
# Retryable = environment / transient. The builder agent could not be launched, timed
# out, or its process crashed — re-running in a fresh session may well succeed. The
# evaluator's non-blocking review verdicts (Red / blocked *without* P0/P1) also reuse the
# existing "fresh session + inject previous findings" retry path, because a fresh agent
# can act on those findings; this is the retryable-with-findings path the acceptance
# preserves ("注入上一轮 review/verify findings"). P0/P1 keep their own immediate-block
# circuit breaker upstream and never reach this classifier's retry decision.
#
# Non-retryable = logic. The builder self-reported a blocker (Multica's `agent_error`),
# verify assertions/tests failed, the queue contract was tampered, agent selection
# failed, or the builder produced no result marker. Re-running the same task blindly just
# burns a round, so we block immediately and do not consume the retry budget.
#
# Classification is deliberately conservative: any status not in the retryable allow-list
# (including unknown/未知 statuses) is treated as non-retryable. We would rather under-retry
# than churn on a real defect while mislabelling it an environment blip.
_RETRYABLE_FAILURE_STATUSES = frozenset(
    {
        "builder_unavailable",  # selected agent CLI could not be launched
        "builder_timeout",  # builder wall-clock timeout
        "builder_failed",  # builder process crashed / non-zero exit
        "review_red",  # evaluator Red without P0/P1 — retry with injected findings
        "review_blocked",  # evaluator soft block — retry with injected findings
    }
)

_NON_RETRYABLE_FAILURE_STATUSES = frozenset(
    {
        "builder_blocked",  # builder self-reported a logic blocker (agent_error)
        "verify_failed",  # verify assertion / test failure
        "queue_contract_red",  # task acceptance/verify tampered
        "safety_policy_red",  # candidate tree violates forbidden path / secret rules
        "review_diff_failed",  # candidate tree could not be captured reliably
        "review_candidate_changed",  # candidate changed after evaluator review
        "agent_selection_failed",  # config/logic error selecting the agent
        "builder_no_result",  # builder ended without an AUTODEV_RESULT marker
        "agent_quota_exhausted",  # account/subscription usage quota needs external recovery
        "context_token_limit",  # prompt must be reduced before retrying
        "rate_limit_exceeded",  # immediate fresh-session retry still hits the same provider gate
    }
)

_SUCCESSFUL_LOOP_TERMINAL_STATUSES = frozenset(
    {
        "max_tasks_reached",
        "no_ready_task",
        "stop_file",
        "global_stop_file",
        "time_budget_exhausted",
        "queue_capacity_full",
    }
)

def _is_runtime_artifact_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return (
        normalized.startswith(".autodev/runs/")
        or normalized.startswith(".autodev/runtime/")
        or normalized == ".autodev/latest_handoff.md"
        or normalized.startswith("outputs/autodev/")
    )


def classify_failure_retryable(status: str) -> bool:
    """H-445: True when ``status`` is an environment/transient failure worth a retry.

    Conservative default: unknown statuses and known logic failures are non-retryable so
    a real defect is not retried indefinitely as if it were a flaky environment blip.
    """
    return status in _RETRYABLE_FAILURE_STATUSES


def loop_status_succeeded(status: str, *, tasks_blocked: int) -> bool:
    """Return success only for an explicitly supported clean loop terminal state."""

    return status in _SUCCESSFUL_LOOP_TERMINAL_STATUSES and tasks_blocked == 0


@dataclass(frozen=True)
class CommandResult:
    command: list[str]
    returncode: int | None
    stdout: str
    stderr: str
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out


@dataclass(frozen=True)
class BuilderExecution:
    result: CommandResult
    session: dict[str, Any]
    attempts: list[dict[str, Any]]


@dataclass(frozen=True)
class ControllerResult:
    ok: bool
    status: str
    message: str
    run_id: str
    task_id: str = ""
    prompt_path: Path | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "message": self.message,
            "run_id": self.run_id,
            "task_id": self.task_id,
            "prompt_path": str(self.prompt_path or ""),
        }


@dataclass(frozen=True)
class LoopTaskOutcome:
    run_id: str
    task_id: str
    status: str
    ok: bool
    message: str
    commit: str = ""
    worktree_path: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "task_id": self.task_id,
            "status": self.status,
            "ok": self.ok,
            "message": self.message,
            "commit": self.commit,
            "worktree_path": self.worktree_path,
        }


@dataclass(frozen=True)
class LoopResult:
    ok: bool
    status: str
    message: str
    run_id: str
    tasks_done: int
    tasks_blocked: int
    summary_path: Path | None = None
    direction_review_path: Path | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "message": self.message,
            "run_id": self.run_id,
            "tasks_done": self.tasks_done,
            "tasks_blocked": self.tasks_blocked,
            "summary_path": str(self.summary_path or ""),
            "direction_review_path": str(self.direction_review_path or ""),
        }


@dataclass
class WorkerAttempt:
    task_id: str
    run_id: str
    process: Any
    result_path: Path
    steer_archive: Path | None
    retry_attempt: int
    retry_artifacts: list[str]
    sequence: int
    cancel_event: Any = None


@dataclass(frozen=True)
class ClaimLease:
    task_id: str
    owner: str
    lease_token: str
    revision: int

    @classmethod
    def from_task(cls, task: dict[str, Any]) -> "ClaimLease":
        task_id = str(task.get("id") or "")
        owner = str(task.get("owner") or "")
        lease_token = str(task.get("lease_token") or "")
        revision = task.get("revision")
        if not task_id or not owner or not lease_token or isinstance(revision, bool) or not isinstance(revision, int):
            raise ValueError("queue claim did not return owner/lease_token/revision")
        return cls(task_id=task_id, owner=owner, lease_token=lease_token, revision=revision)


class _LeaseBoundQueuePort:
    """Delegate queue operations while binding finalize calls to one claim CAS."""

    def __init__(self, delegate: QueuePort, lease: ClaimLease):
        self._delegate = delegate
        self.lease = lease

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)

    def done(
        self,
        task_id: str,
        *,
        note: str = "",
        artifacts: list[str] | None = None,
        **_: Any,
    ) -> Any:
        return self._delegate.done(
            task_id,
            note=note,
            artifacts=artifacts,
            expected_owner=self.lease.owner,
            expected_lease_token=self.lease.lease_token,
            expected_revision=self.lease.revision,
            review_passed=True,
        )

    def block(
        self,
        task_id: str,
        *,
        reason: str,
        next_action: str = "",
        failure_status: str = "",
        failure_run_id: str = "",
        **_: Any,
    ) -> Any:
        return self._delegate.block(
            task_id,
            reason=reason,
            next_action=next_action,
            expected_owner=self.lease.owner,
            expected_lease_token=self.lease.lease_token,
            expected_revision=self.lease.revision,
            failure_status=failure_status,
            failure_run_id=failure_run_id,
        )

    def release(self, task_id: str, *, note: str = "", **_: Any) -> Any:
        return self._delegate.release(
            task_id,
            note=note,
            expected_owner=self.lease.owner,
            expected_lease_token=self.lease.lease_token,
            expected_revision=self.lease.revision,
        )


class _ClaimLifecycle:
    """Best-effort terminal settlement for every claimed task, including interrupts."""

    def __init__(self, config: AutoDevConfig):
        self.config = config
        self.run_id = ""
        self.task_id = ""
        self.port: _LeaseBoundQueuePort | None = None
        self.finalized = False
        self.capacity_lease: HostCapacityLease | None = None

    def bind(self, run_id: str, task_id: str, port: _LeaseBoundQueuePort) -> None:
        self.run_id = run_id
        self.task_id = task_id
        self.port = port

    @property
    def claimed(self) -> bool:
        return bool(self.task_id and self.port)

    def mark_finalized(self) -> None:
        self.finalized = True

    def bind_capacity(self, lease: HostCapacityLease) -> None:
        self.capacity_lease = lease

    def close_capacity(self) -> None:
        if self.capacity_lease is not None:
            self.capacity_lease.close()
            self.capacity_lease = None

    def settle_exception(self, exc: BaseException) -> ControllerResult:
        return self.settle_message(f"{type(exc).__name__}: {exc}")

    def settle_message(self, detail: str) -> ControllerResult:
        message = f"claimed task lifecycle failed: {detail}"
        block_ok = self.finalized
        block_error = ""
        if self.port is not None and not self.finalized:
            try:
                blocked = self.port.block(
                    self.task_id,
                    reason=message,
                    next_action="人工 reconcile queue lease 后重跑",
                    failure_status="system_error",
                    failure_run_id=self.run_id,
                )
                block_ok = bool(blocked.ok)
                if not block_ok:
                    block_error = blocked.message or blocked.status
            except BaseException as block_exc:  # cleanup must survive KeyboardInterrupt/SystemExit too
                block_error = f"{type(block_exc).__name__}: {block_exc}"
        if block_error:
            message += f"; queue settlement failed ({block_error}); explicit manual reconcile required"
        try:
            _mark_run(
                self.config,
                self.run_id,
                status="system_error",
                task_id=self.task_id,
                task_status="done" if self.finalized else "blocked" if block_ok else "system_error",
                message=message,
                blocked_delta=1 if block_ok and not self.finalized else 0,
                failure_delta=1,
            )
        except BaseException:
            pass
        try:
            append_event(
                self.config.project.repo_root,
                self.run_id,
                level="error",
                phase="system_error",
                task_id=self.task_id,
                message=message,
                extra={"queue_settled": block_ok, "finalized": self.finalized},
            )
        except BaseException:
            pass
        try:
            _write_task_handoff_safe(self.config, self.run_id, self.task_id, self.port)
        except BaseException:
            pass
        return ControllerResult(
            ok=False,
            status="system_error",
            message=message,
            run_id=self.run_id,
            task_id=self.task_id,
        )


def _new_run_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}-{secrets.token_hex(4)}-run-one"


def _new_loop_run_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}-{secrets.token_hex(4)}-run-loop"


def _timeout_seconds(minutes: int | None, default_minutes: int) -> int:
    return int((minutes or default_minutes) * 60)


def _run_command(
    command: list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    stdin: str = "",
) -> CommandResult:
    try:
        proc = run_process_group(
            command,
            cwd=cwd,
            stdin=stdin,
            timeout_seconds=timeout_seconds,
        )
        return CommandResult(
            command=command,
            returncode=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
            timed_out=proc.timed_out,
        )
    except (FileNotFoundError, OSError) as exc:
        return CommandResult(command=command, returncode=None, stdout="", stderr=str(exc))


def _builder_attempt(
    builder: AgentCommandConfig,
    invocation: BuilderInvocation,
    *,
    cwd: Path,
    timeout_seconds: int,
    prompt: str,
) -> tuple[CommandResult, dict[str, Any], str]:
    raw = _run_command(
        invocation.argv,
        cwd=cwd,
        timeout_seconds=timeout_seconds,
        stdin=prompt,
    )
    decoded = decode_builder_output(builder, raw.stdout)
    session_id = decoded.session_id or invocation.session_id or invocation.source_session_id
    normalized = CommandResult(
        command=raw.command,
        returncode=raw.returncode,
        stdout=decoded.stdout,
        stderr=raw.stderr,
        timed_out=raw.timed_out,
    )
    attempt = {
        "mode": invocation.mode,
        "command": raw.command,
        "returncode": raw.returncode,
        "timed_out": raw.timed_out,
        "stdout": decoded.stdout,
        "stderr": raw.stderr,
        "session_id": session_id,
    }
    if decoded.raw_stdout != decoded.stdout:
        attempt["raw_stdout"] = decoded.raw_stdout
    return normalized, attempt, session_id


def _run_builder_with_session_affinity(
    builder: AgentCommandConfig,
    base_command: list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    prompt: str,
    resume_session_id: str = "",
    source_run_id: str = "",
    affinity_reason: str = "",
) -> BuilderExecution:
    """Prefer one same-task resume, then use remaining time for a fresh fallback."""
    invocation = build_builder_invocation(
        builder,
        base_command,
        resume_session_id=resume_session_id,
    )
    started = time.monotonic()
    result, attempt, session_id = _builder_attempt(
        builder,
        invocation,
        cwd=cwd,
        timeout_seconds=timeout_seconds,
        prompt=prompt,
    )
    attempts = [attempt]
    fallback_reason = ""

    if invocation.mode == "resumed" and not result.ok:
        limit_status, limit_message = _classify_agent_limit(result.stdout, result.stderr)
        elapsed = max(0.0, time.monotonic() - started)
        remaining = max(0, int(timeout_seconds - elapsed))
        # A fresh session cannot repair an account/provider gate, a missing
        # executable, or a resume call that already consumed the whole timeout.
        can_fallback = (
            remaining > 0
            and result.returncode is not None
            and not result.timed_out
            and limit_status not in {"agent_quota_exhausted", "rate_limit_exceeded"}
        )
        if can_fallback:
            fallback_reason = limit_message or result.stderr.strip() or (
                f"resumed builder exited with {result.returncode}"
            )
            fresh = build_builder_invocation(builder, base_command, fallback=True)
            fallback_prompt = (
                prompt
                + "\n\n### Session Resume Fallback\n\n"
                + "The previous builder conversation could not be resumed cleanly. "
                + "Inspect the current worktree for any partial edits left by that attempt, "
                + "preserve valid work, and finish the requested repair without rewriting "
                + "unrelated code.\n"
            )
            result, fresh_attempt, session_id = _builder_attempt(
                builder,
                fresh,
                cwd=cwd,
                timeout_seconds=max(1, remaining),
                prompt=fallback_prompt,
            )
            attempts.append(fresh_attempt)
            invocation = fresh

    session = {
        "mode": invocation.mode,
        "session_id": session_id,
        "source_session_id": resume_session_id,
        "source_run_id": source_run_id,
        "resume_attempted": bool(resume_session_id),
        "fallback_reason": fallback_reason,
        "affinity_reason": affinity_reason,
    }
    return BuilderExecution(result=result, session=session, attempts=attempts)


def _git(config: AutoDevConfig, *args: str) -> CommandResult:
    return _run_command(["git", *args], cwd=config.project.repo_root, timeout_seconds=60)


def _git_at(cwd: Path, *args: str) -> CommandResult:
    return _run_command(["git", *args], cwd=cwd, timeout_seconds=60)


def _is_git_dirty(config: AutoDevConfig) -> bool:
    status = _git(config, "status", "--porcelain")
    if not status.ok:
        return True
    lines = []
    for line in status.stdout.splitlines():
        path = line[3:] if len(line) > 3 else ""
        if path.startswith(".autodev/") or path.startswith("outputs/autodev/"):
            continue
        lines.append(line)
    return bool(lines)


def _resolve_executable(command: str, cwd: Path) -> str:
    if "/" in command:
        path = Path(command)
        if not path.is_absolute():
            path = cwd / path
        if path.exists() and path.is_file():
            return str(path)
        return ""
    return shutil.which(command) or ""


def _check_verify_commands(config: AutoDevConfig, commands: list[str]) -> list[str]:
    errors: list[str] = []
    for command in commands:
        parts = shlex.split(command)
        if not parts:
            errors.append("verify command is empty")
            continue
        if not _resolve_executable(parts[0], config.project.repo_root):
            errors.append(f"verify command not executable: {parts[0]}")
    return errors


def _preflight(config: AutoDevConfig, run_id: str, *, dry_run: bool = False) -> tuple[bool, dict[str, Any], list[str]]:
    repo_root = config.project.repo_root
    details: dict[str, Any] = {"warnings": [], "errors": []}

    base_ref = config.branch.base_ref.strip()
    if config.policy.require_explicit_base_commit and not base_ref:
        details["errors"].append("branch.base_ref is required")
    if base_ref:
        base = _git(config, "rev-parse", "--verify", base_ref)
        if base.ok:
            details["base_sha"] = base.stdout.strip()
        else:
            details["errors"].append(f"base_ref is not resolvable: {base_ref}")

    dirty = _is_git_dirty(config)
    details["main_worktree_dirty"] = dirty
    if dirty:
        if config.branch.worktree.enabled and config.policy.main_worktree_dirty_policy == "warn":
            details["warnings"].append("main worktree is dirty; worktree mode allows continuing with warning")
            append_event(
                repo_root,
                run_id,
                level="warning",
                phase="preflight",
                message="main worktree is dirty; continuing because worktree mode is enabled",
            )
        else:
            details["errors"].append("main worktree is dirty")

    if config.branch.worktree.enabled:
        setup = config.branch.worktree.setup
        if setup.mode == "symlink_venv" and setup.source:
            source = repo_root / setup.source
            if not source.exists():
                details["errors"].append(f"worktree setup source not found: {setup.source}")
        elif setup.mode not in {"none", "symlink_venv"}:
            details["errors"].append(f"unsupported worktree setup mode: {setup.mode}")

    if config.policy.require_worktree_isolation and not dry_run and not config.branch.worktree.enabled:
        details["errors"].append("policy.require_worktree_isolation is true but branch.worktree.enabled is false")

    details["safety_errors"] = check_project_safety_policy(config)
    details["errors"].extend(details["safety_errors"])

    details["notification_errors"] = validate_notifications_config(config)
    details["errors"].extend(details["notification_errors"])

    details["verify_errors"] = _check_verify_commands(config, config.verify.default)
    details["errors"].extend(details["verify_errors"])
    ok = not details["errors"]
    level = "info" if ok else "error"
    append_event(
        repo_root,
        run_id,
        level=level,
        phase="preflight",
        message="preflight passed" if ok else "preflight failed",
        extra=details,
    )
    return ok, details, list(details["errors"])


def _snapshot_task(config: AutoDevConfig, task_id: str, queue_port: QueuePort | None = None) -> dict[str, Any]:
    task = (queue_port or create_queue_port(config)).get_task(task_id)
    return {
        "id": str(task.get("id") or ""),
        "title": str(task.get("title") or ""),
        "status": str(task.get("status") or ""),
        "priority": str(task.get("priority") or ""),
        "area": str(task.get("area") or ""),
        "goal": str(task.get("goal") or ""),
        "acceptance": list(task.get("acceptance") or []),
        "verify": list(task.get("verify") or []),
        "artifacts": list(task.get("artifacts") or []),
        "raw": task,
    }


def _select_task(
    config: AutoDevConfig,
    task_id: str,
    queue_port: QueuePort | None = None,
) -> dict[str, Any] | None:
    if task_id:
        return _snapshot_task(config, task_id, queue_port)
    result = (queue_port or create_queue_port(config)).next()
    return result.task if result.ok else None


def _prompt_template(config: AutoDevConfig) -> str:
    path = config.project.repo_root / PROMPT_TEMPLATE
    if path.exists():
        return path.read_text(encoding="utf-8")
    return (
        "# AUTODEV_PROMPT\n\n"
        "你是本仓库的 AutoDev builder。只完成本次任务，完成后输出 AUTODEV_RESULT 标记。\n"
    )


def build_builder_prompt(
    config: AutoDevConfig,
    task: dict[str, Any],
    *,
    run_id: str,
    base_sha: str = "",
    workspace_path: Path | None = None,
    builder: AgentCommandConfig | None = None,
    builder_name: str = "",
    steer_text: str = "",
    retry_context: str = "",
    handoff_context: str = "",
) -> str:
    selected_builder = builder or config.agent.builder
    verify_commands = verify_commands_for_task(task, config.verify.default)
    acceptance = "\n".join(f"- {item}" for item in task.get("acceptance") or ["(none)"])
    verify = "\n".join(f"- `{item}`" for item in verify_commands)
    artifacts = "\n".join(f"- `{item}`" for item in task.get("artifacts") or [])
    raw_contract = task.get("raw") if isinstance(task.get("raw"), dict) else task
    development_prompt = str(raw_contract.get("development_prompt") or "").strip()
    expected_files = "\n".join(
        f"- `{item}`" for item in raw_contract.get("expected_files") or []
    )
    completion_evidence = "\n".join(
        f"- [{'required' if item.get('required') else 'optional'}] "
        f"{item.get('kind')}: {item.get('description')}"
        for item in raw_contract.get("completion_evidence") or []
        if isinstance(item, dict)
    )
    model_route = raw_contract.get("model_route") or {}
    if not isinstance(model_route, dict):
        model_route = {}
    rules = [
        "只完成本任务，不领取或修改其他任务。",
        "不要修改任务 acceptance / verify 来让自己通过。",
        "不要 commit、push、部署或重启服务。",
        "不要调用 save-context 或写 brain memory；接力上下文只能由 harness 渲染 handoff packet。",
        "必须以 AUTODEV_RESULT: done|blocked 结构化标记结束。",
    ]
    prompt = [
        _prompt_template(config).rstrip(),
        "",
        "---",
        "",
        "## Harness Run Context",
        "",
        f"- project_id: `{config.project.id}`",
        f"- repo_root: `{workspace_path or config.project.repo_root}`",
        f"- main_repo_root: `{config.project.repo_root}`",
        f"- run_id: `{run_id}`",
        f"- base_ref: `{config.branch.base_ref}`",
        f"- base_sha: `{base_sha}`",
        f"- builder_name: `{builder_name or config.agent.builder_name}`",
        f"- builder_timeout_minutes: `{selected_builder.timeout_minutes or ''}`",
        f"- max_turns: `{selected_builder.max_turns or ''}`",
        f"- verify_timeout_minutes: `{config.verify.command_timeout_minutes}`",
        "",
        "## Latest Handoff Context",
        "",
        handoff_context.strip() or "(no handoff packet available yet)",
        "",
        "## Project Rules Summary",
        "",
        *(f"- {rule}" for rule in rules),
        "",
        "## 本次任务",
        "",
        f"- id: `{task.get('id')}`",
        f"- title: {task.get('title')}",
        f"- priority: `{task.get('priority')}`",
        f"- area: `{task.get('area')}`",
        "",
        "### Goal",
        "",
        str(task.get("goal") or "(none)"),
        "",
        "### Acceptance",
        "",
        acceptance,
        "",
        "### Verify",
        "",
        verify,
    ]
    if artifacts:
        prompt.extend(["", "### Expected Artifacts", "", artifacts])
    if development_prompt:
        prompt.extend(
            [
                "",
                "### Approved Development Contract",
                "",
                development_prompt,
            ]
        )
    if expected_files:
        prompt.extend(["", "### Expected Files", "", expected_files])
    if completion_evidence:
        prompt.extend(["", "### Completion Evidence", "", completion_evidence])
    if model_route:
        prompt.extend(
            [
                "",
                "### Approved Model Route",
                "",
                f"- capability_tier: `{model_route.get('capability_tier') or ''}`",
                f"- reasoning_effort: `{model_route.get('reasoning_effort') or ''}`",
                f"- policy_revision: `{model_route.get('policy_revision') or ''}`",
                f"- execution_wave: `{raw_contract.get('execution_wave') or ''}`",
            ]
        )
    if steer_text.strip():
        prompt.extend(["", "### Human Steer", "", steer_text.strip()])
    if retry_context.strip():
        prompt.extend(["", "### Retry Context", "", retry_context.strip()])
    prompt.extend(
        [
            "",
            "### Required Final Marker",
            "",
            "`AUTODEV_RESULT: done | <summary>` or `AUTODEV_RESULT: blocked | <reason and next_action>`",
            "",
        ]
    )
    return "\n".join(prompt)


def _task_artifact_dir(config: AutoDevConfig, run_id: str, task_id: str) -> Path:
    path = run_paths(config.project.repo_root, run_id).tasks_dir / validate_task_id(task_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write_task_artifact(config: AutoDevConfig, run_id: str, task_id: str, name: str, content: str) -> Path:
    target = _task_artifact_dir(config, run_id, task_id) / name
    atomic_write_text(target, content)
    return target


def _candidate_review_diff(cwd: Path, base_sha: str) -> str:
    if not base_sha:
        raise AutoDevGitError("review diff requires an explicit base commit")
    untracked = _git_at(cwd, "ls-files", "--others", "--exclude-standard")
    if not untracked.ok:
        raise AutoDevGitError(f"review diff cannot list untracked files: {untracked.stderr or untracked.stdout}")
    # Ignore only *untracked* harness runtime output. Tracked historical
    # handoffs/reviews under the same path prefixes remain part of the base
    # comparison below and therefore cannot bypass evaluator review.
    paths = [
        line
        for line in untracked.stdout.splitlines()
        if line.strip() and not _is_runtime_artifact_path(line)
    ]
    if paths:
        intent = _run_command(["git", "add", "-N", "--", *paths], cwd=cwd, timeout_seconds=60)
        if not intent.ok:
            raise AutoDevGitError(
                f"review diff cannot stage intent for untracked files: {intent.stderr or intent.stdout}"
            )
    # Compare the complete candidate worktree to the base commit. Unlike a
    # plain `git diff -- .`, this includes builder-staged changes and commits
    # made by the builder, while intent-to-add above surfaces new files.
    diff = _git_at(
        cwd,
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        base_sha,
        "--",
        ".",
    )
    if not diff.ok:
        raise AutoDevGitError(f"review diff failed: {diff.stderr or diff.stdout}")
    return diff.stdout


def _prepare_review_diff(
    config: AutoDevConfig,
    run_id: str,
    task_id: str,
    cwd: Path,
    base_sha: str,
) -> str:
    diff_text = _candidate_review_diff(cwd, base_sha)
    _write_task_artifact(config, run_id, task_id, "diff.patch", diff_text)
    return diff_text


def _workspace_queue_path(config: AutoDevConfig, workspace: WorktreeContext) -> Path:
    try:
        relative = config.queue.path.relative_to(config.project.repo_root)
    except ValueError:
        return config.queue.path
    return workspace.path / relative


def _task_contract_drift(config: AutoDevConfig, task: dict[str, Any], workspace: WorktreeContext) -> list[str]:
    reasons = task_contract_drift(config.queue.path, task)
    workspace_queue = _workspace_queue_path(config, workspace)
    if workspace_queue != config.queue.path:
        for reason in task_contract_drift(workspace_queue, task):
            reasons.append(f"workspace {reason}")
    return reasons


def _base_ref_queue_task_ids(config: AutoDevConfig, ref: str) -> set[str] | None:
    """Task ids present in the queue file at git ``ref``.

    Returns ``None`` when the base queue cannot be read (empty ref, queue file not
    tracked at that ref, or unparseable). Callers treat ``None`` as "unknown" and fall
    back to the existing drift semantics rather than blocking.
    """
    if not ref:
        return None
    try:
        relative = config.queue.path.relative_to(config.project.repo_root)
    except ValueError:
        return None
    show = _git(config, "show", f"{ref}:{relative.as_posix()}")
    if not show.ok:
        return None
    try:
        queue = yaml.safe_load(show.stdout) or {}
    except Exception:
        return None
    tasks = queue.get("tasks") if isinstance(queue, dict) else None
    if not isinstance(tasks, list):
        return None
    return {
        str(task.get("id") or "").strip()
        for task in tasks
        if isinstance(task, dict) and str(task.get("id") or "").strip()
    }


def _base_queue_membership_error(config: AutoDevConfig, base_ref: str, task_id: str) -> str:
    """Fail-loud message when ``task_id`` is missing from the base_ref queue (H-446).

    The worktree is built from ``base_ref``; a pending task that exists only in an
    uncommitted main-queue edit is absent from the worktree queue and later mis-flagged
    as ``queue_contract_red`` after the builder already did valid work (2026-07-09 H-444
    overnight miss). Catch it here, before claim/builder. Empty string means the gate
    passes (task present, or base queue unreadable → defer to the existing drift check).
    """
    if not task_id:
        return ""
    ids = _base_ref_queue_task_ids(config, base_ref)
    if ids is None or task_id in ids:
        return ""
    base_label = base_ref or config.branch.base_ref or "base_ref"
    try:
        queue_label = config.queue.path.relative_to(config.project.repo_root).as_posix()
    except ValueError:
        queue_label = str(config.queue.path)
    return (
        f"pending 任务 {task_id} 不在 base_ref（{base_label}）对应的队列文件中："
        "队列改动很可能尚未 commit 到 base_ref。worktree 从旧 base 建，会把 builder 的正常产出误判为 "
        f"queue_contract_red。请先把 {queue_label} 提交到 base_ref 再重跑。"
    )


def _workspace_queue_membership_error(config: AutoDevConfig, workspace: WorktreeContext, task_id: str) -> str:
    """Fail-loud when the candidate task is missing from the workspace queue (P2-B).

    The base-ref gate only proves the task is committed to base_ref; the builder reads
    the queue checked out in the worktree. A reused worktree whose integration branch
    drifted from base_ref used to surface only as ``queue_contract_red`` after the
    builder had already burned a real agent call (2026-07-10 E-203). The worktree is
    fast-forwarded on reuse now, so this is the pre-builder backstop for any remaining
    path. Missing, invalid, or task-incomplete workspace queues fail closed before the
    builder starts; an empty string means the gate passes.
    """
    if not task_id or not workspace.isolated:
        return ""
    workspace_queue = _workspace_queue_path(config, workspace)
    if workspace_queue == config.queue.path:
        return ""
    try:
        queue = load_queue(workspace_queue)
    except Exception as exc:
        return (
            f"worktree 队列文件缺失或不可读（{workspace_queue}）：{exc}。"
            "builder 不会启动；请恢复与 base_ref 一致的有效 v1 队列后重跑。"
        )
    tasks = queue.get("tasks") or []
    ids = {str(item.get("id") or "").strip() for item in tasks if isinstance(item, dict)}
    if task_id in ids:
        return ""
    return (
        f"任务 {task_id} 不在 worktree 检出的队列文件中（{workspace_queue}）："
        "集成分支上的队列版本与主队列不一致。builder 不会启动；"
        "请确认队列改动已提交到 base_ref 且集成分支未分叉后重跑。"
    )


def _builder_command(builder: AgentCommandConfig, verify_commands: list[str]) -> list[str]:
    return build_agent_argv(builder, role="builder", verify_commands=verify_commands)


def _parse_builder_result(stdout: str, stderr: str) -> tuple[str, str]:
    """Parse the AUTODEV_RESULT marker from stdout ONLY.

    stderr is deliberately excluded: Codex CLI echoes the full builder prompt
    (which contains the literal marker example from the "Required Final
    Marker" section) to stderr, and the reversed scan would hit that echo
    before the real marker. Same failure family as the evaluator F1 fix
    (2026-07-11); stderr stays archived in builder.json for forensics.
    """
    del stderr
    for line in reversed(stdout.splitlines()):
        stripped = line.strip()
        if stripped.startswith(RESULT_PREFIX):
            payload = stripped[len(RESULT_PREFIX) :].strip()
            status, _, message = payload.partition("|")
            return status.strip().lower(), message.strip()
    return "", ""


def _classify_agent_limit(stdout: str, stderr: str) -> tuple[str, str]:
    """Classify explicit model resource-limit diagnostics from a failed CLI.

    The matcher is intentionally narrow. Agent CLIs may echo the task prompt to
    stderr, so generic words such as ``token`` or ``limit`` must never be enough
    to change lifecycle semantics.
    """
    diagnostic = f"{stdout[-8000:]}\n{stderr[-8000:]}".lower()
    context_markers = (
        "maximum context length",
        "context length exceeded",
        "context window exceeded",
        "prompt is too long",
        "request too large for model",
    )
    quota_markers = (
        "you've hit your limit",
        "you've hit your session limit",
        "you have hit your limit",
        "you have hit your session limit",
        "usage limit reached",
        "usage limit has been reached",
        "insufficient_quota",
        "quota exceeded",
        "credit balance is too low",
    )
    rate_markers = (
        "rate limit exceeded",
        "rate_limit_exceeded",
        "too many requests",
    )
    if any(marker in diagnostic for marker in context_markers):
        return "context_token_limit", "模型上下文 Token 超限；请缩短输入或拆分任务后再继续"
    if any(marker in diagnostic for marker in quota_markers):
        return "agent_quota_exhausted", "模型账号用量额度已用完；请等待额度恢复或切换可用账号后再继续"
    if any(marker in diagnostic for marker in rate_markers):
        return "rate_limit_exceeded", "模型调用频率受限；请等待频率额度恢复后再继续"
    return "", ""


def _record_workspace(
    config: AutoDevConfig,
    run_id: str,
    workspace: WorktreeContext,
    *,
    candidate_base_sha: str,
) -> None:
    def mutate(run: dict[str, Any]) -> None:
        git = run.setdefault("git", {})
        git["base_ref"] = workspace.base_ref
        git["base_sha"] = workspace.base_sha
        git["candidate_base_sha"] = candidate_base_sha
        git["branch"] = workspace.branch
        git["integration_branch"] = workspace.integration_branch
        git["integration_base_sha"] = workspace.integration_base_sha
        git["worktree_path"] = str(workspace.path)

    mutate_run(config.project.repo_root, run_id, mutate)


def _record_commit(config: AutoDevConfig, run_id: str, commit_sha: str) -> None:
    if not commit_sha:
        return

    def mutate(run: dict[str, Any]) -> None:
        run.setdefault("current_task", {})["commit"] = commit_sha

    mutate_run(config.project.repo_root, run_id, mutate)


def _record_claim(config: AutoDevConfig, run_id: str, lease: ClaimLease) -> None:
    def mutate(run: dict[str, Any]) -> None:
        run["queue_claim"] = {
            "task_id": lease.task_id,
            "owner": lease.owner,
            "lease_token": lease.lease_token,
            "revision": lease.revision,
        }

    mutate_run(config.project.repo_root, run_id, mutate)


def _record_agent_selection(config: AutoDevConfig, run_id: str, task_id: str, selection: AgentSelection) -> None:
    def mutate(run: dict[str, Any]) -> None:
        current = run.setdefault("current_task", {})
        if task_id:
            current["id"] = task_id
        current["agent_selection"] = selection.to_event_dict()

    mutate_run(config.project.repo_root, run_id, mutate)


def _record_builder_session(
    config: AutoDevConfig,
    run_id: str,
    session: dict[str, Any],
) -> None:
    def mutate(run: dict[str, Any]) -> None:
        run.setdefault("current_task", {})["builder_session"] = dict(session)

    mutate_run(config.project.repo_root, run_id, mutate)


def _write_task_handoff_safe(
    config: AutoDevConfig,
    run_id: str,
    task_id: str,
    queue_port: QueuePort | None = None,
) -> None:
    if not task_id or not config.context_sharing.enabled:
        return
    try:
        run = load_run(config.project.repo_root, run_id)
        publish_latest = not bool(run.get("supervisor_pid"))
        md_path, yaml_path = write_task_handoff(
            config,
            run_id,
            task_id,
            queue_port=queue_port,
            publish_latest=publish_latest,
        )
        append_event(
            config.project.repo_root,
            run_id,
            level="info",
            phase="handoff",
            task_id=task_id,
            message="task handoff packet written",
            artifact=str(md_path),
            extra={"yaml": str(yaml_path)},
        )
    except Exception as exc:
        append_event(
            config.project.repo_root,
            run_id,
            level="warning",
            phase="handoff",
            task_id=task_id,
            message=f"task handoff packet failed: {exc}",
        )


def _mark_run(
    config: AutoDevConfig,
    run_id: str,
    *,
    status: str,
    task_id: str = "",
    task_status: str = "",
    message: str = "",
    base_sha: str = "",
    done_delta: int = 0,
    blocked_delta: int = 0,
    failure_delta: int = 0,
) -> None:
    def mutate(run: dict[str, Any]) -> None:
        run["status"] = status
        if base_sha:
            run.setdefault("git", {})["base_sha"] = base_sha
        if task_id or task_status:
            current = run.setdefault("current_task", {})
            if task_id:
                current["id"] = task_id
            if task_status:
                current["status"] = task_status
        summary = run.setdefault("summary", {})
        summary["tasks_done"] = int(summary.get("tasks_done") or 0) + done_delta
        summary["tasks_blocked"] = int(summary.get("tasks_blocked") or 0) + blocked_delta
        summary["consecutive_failures"] = int(summary.get("consecutive_failures") or 0) + failure_delta
        if message:
            run["next_action"] = message

    mutate_run(config.project.repo_root, run_id, mutate)


def _sync_run_review_findings(config: AutoDevConfig, run_id: str, task_id: str) -> None:
    """Project structured review priorities into a standalone run summary."""
    if not task_id:
        return
    review_path = run_paths(config.project.repo_root, run_id).tasks_dir / task_id / "review.yaml"
    if not review_path.exists():
        return
    try:
        review = yaml.safe_load(review_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        # Failure journaling must never mask the original controller failure
        # because a review artifact is missing, truncated, or malformed.
        return
    if not isinstance(review, dict):
        return
    counts = {"p0": 0, "p1": 0}
    for finding in review.get("findings") or []:
        if not isinstance(finding, dict):
            continue
        priority = str(finding.get("priority") or "").lower()
        if priority in counts:
            counts[priority] += 1

    def mutate(run: dict[str, Any]) -> None:
        findings = run.setdefault("summary", {}).setdefault("findings", {})
        findings.update(counts)

    mutate_run(config.project.repo_root, run_id, mutate)


def _fail(
    config: AutoDevConfig,
    run_id: str,
    *,
    status: str,
    message: str,
    task_id: str = "",
    block_task: bool = False,
    queue_port: QueuePort | None = None,
    force_reconcile_block: bool = False,
    record_task_failure: bool = True,
) -> ControllerResult:
    block_succeeded = False
    if task_id and block_task:
        review_gate = status in {"review_red", "review_blocked", "safety_policy_red", "queue_contract_red"}
        try:
            blocked = (queue_port or create_queue_port(config)).block(
                task_id,
                reason=message,
                next_action=(
                    "resolve_blocking_findings_and_re_review"
                    if review_gate
                    else "人工检查 AutoDev run"
                ),
                failure_status=status if record_task_failure else "",
                failure_run_id=run_id if record_task_failure else "",
                force_reconcile=force_reconcile_block,
            )
            block_succeeded = bool(blocked.ok)
            if not block_succeeded:
                block_error = blocked.message or blocked.status
                message = (
                    f"{message}; queue block/finalize failed ({block_error}); "
                    "explicit manual reconcile required"
                )
                status = "system_error"
        except Exception as exc:
            message = (
                f"{message}; queue block/finalize raised {type(exc).__name__}: {exc}; "
                "explicit manual reconcile required"
            )
            status = "system_error"
    _mark_run(
        config,
        run_id,
        status=status,
        task_id=task_id,
        task_status="blocked" if block_succeeded else "system_error" if task_id and block_task else "",
        message=message,
        blocked_delta=1 if block_succeeded else 0,
        failure_delta=1,
    )
    _sync_run_review_findings(config, run_id, task_id)
    append_event(config.project.repo_root, run_id, level="error", phase=status, task_id=task_id, message=message)
    _write_task_handoff_safe(config, run_id, task_id, queue_port)
    return ControllerResult(ok=False, status=status, message=message, run_id=run_id, task_id=task_id)


def _release_claim_failure(
    config: AutoDevConfig,
    run_id: str,
    *,
    lifecycle: _ClaimLifecycle,
    status: str,
    message: str,
) -> ControllerResult:
    """Release a claim when no task failure has occurred yet."""
    if lifecycle.port is None or not lifecycle.task_id:
        return _fail(config, run_id, status=status, message=message)
    released = lifecycle.port.release(
        lifecycle.task_id,
        note=f"AutoDev released before worker execution: {status}: {message}",
    )
    if not released.ok:
        return lifecycle.settle_message(
            f"queue release failed ({released.status}): {released.message or message}"
        )
    lifecycle.mark_finalized()
    _mark_run(
        config,
        run_id,
        status=status,
        task_id=lifecycle.task_id,
        task_status="pending",
        message=message,
    )
    append_event(
        config.project.repo_root,
        run_id,
        level="warning",
        phase=status,
        task_id=lifecycle.task_id,
        message=message,
        extra={"queue_released": True},
    )
    return ControllerResult(
        ok=False,
        status=status,
        message=message,
        run_id=run_id,
        task_id=lifecycle.task_id,
    )


def _standalone_retry_source(
    config: AutoDevConfig,
    *,
    task_id: str,
    source_run_id: str,
    next_attempt: int,
) -> tuple[str, Path]:
    source_run_id = validate_run_id(source_run_id)
    source = load_run(config.project.repo_root, source_run_id)
    source_task = source.get("current_task") or {}
    if str(source.get("project_id") or "") != config.project.id:
        raise ValueError(f"retry source {source_run_id} belongs to another project")
    if str(source_task.get("id") or "") != task_id:
        raise ValueError(
            f"retry source {source_run_id} is for {source_task.get('id') or '-'}, not {task_id}"
        )
    source_status = str(source.get("status") or "")
    source_failures = int((source.get("summary") or {}).get("consecutive_failures") or 0)
    if source_failures < 1 or source_status in {"done", "candidate_ready", "dry_run"}:
        raise ValueError(f"retry source {source_run_id} is not a failed candidate: {source_status}")

    task_dir = run_paths(config.project.repo_root, source_run_id).tasks_dir / task_id
    patch_path = task_dir / "diff.patch"
    if not patch_path.exists():
        git_state = source.get("git") or {}
        worktree_path = Path(str(git_state.get("worktree_path") or ""))
        base_sha = str(git_state.get("candidate_base_sha") or git_state.get("base_sha") or "")
        if not worktree_path.exists() or not base_sha:
            raise ValueError(
                f"retry source {source_run_id} has no diff.patch or recoverable worktree"
            )
        patch_text = _candidate_review_diff(worktree_path, base_sha)
        patch_path = task_dir / "retry_candidate.patch"
        atomic_write_text(patch_path, patch_text)

    context, _ = _retry_context(
        config,
        LoopTaskOutcome(
            run_id=source_run_id,
            task_id=task_id,
            status=source_status,
            ok=False,
            message=str(source.get("next_action") or source_status),
            worktree_path=str((source.get("git") or {}).get("worktree_path") or ""),
        ),
        next_attempt=next_attempt,
    )
    return context, patch_path


def _inspect_conflict_markers(workspace: Path, paths: list[str]) -> tuple[list[str], list[str]]:
    marker_paths: list[str] = []
    unreadable_paths: list[str] = []
    for relative in paths:
        target = workspace / relative
        if not target.exists():
            continue
        try:
            lines = target.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError):
            unreadable_paths.append(relative)
            continue
        if any(
            line.startswith("<<<<<<< ")
            or line == "======="
            or line.startswith(">>>>>>> ")
            for line in lines
        ):
            marker_paths.append(relative)
    return marker_paths, unreadable_paths


def _changed_worktree_paths(workspace: Path) -> list[str]:
    changed = _run_command(
        ["git", "diff", "--name-only", "-z", "HEAD"],
        cwd=workspace,
        timeout_seconds=60,
    )
    if not changed.ok:
        raise AutoDevGitError(
            f"retry candidate paths could not be inspected: {changed.stderr or changed.stdout}"
        )
    return [item for item in changed.stdout.split("\0") if item]


def _apply_retry_patch(workspace: Path, patch_path: Path) -> list[str]:
    """Restore a failed candidate and return files needing builder repair.

    ``git apply --3way`` exits non-zero both for an invalid patch and for an
    otherwise valid three-way application that leaves content conflicts.  The
    latter is useful retry state: non-conflicting candidate edits have already
    been restored, and the next builder should resolve the small delta against
    the newer integration base.  Convert only that auditable case into ordinary
    unstaged conflict-marker files; malformed/unexplained failures still abort.
    """
    if not patch_path.read_text(encoding="utf-8").strip():
        return []
    applied = _run_command(
        ["git", "apply", "--3way", "--whitespace=nowarn", str(patch_path)],
        cwd=workspace,
        timeout_seconds=120,
    )
    conflict_paths: list[str] = []
    if not applied.ok:
        unmerged = _run_command(
            ["git", "diff", "--name-only", "--diff-filter=U", "-z"],
            cwd=workspace,
            timeout_seconds=60,
        )
        if not unmerged.ok:
            raise AutoDevGitError(
                f"retry patch from {patch_path} failed and conflict paths could not be inspected: "
                f"{unmerged.stderr or unmerged.stdout}"
            )
        conflict_paths = [item for item in unmerged.stdout.split("\0") if item]
        if not conflict_paths:
            raise AutoDevGitError(
                f"retry patch from {patch_path} does not apply cleanly: "
                f"{applied.stderr or applied.stdout}"
            )
        apply_diagnostics = f"{applied.stderr}\n{applied.stdout}".lower()
        if "error:" in apply_diagnostics or "patch failed" in apply_diagnostics:
            raise AutoDevGitError(
                f"retry patch from {patch_path} had failures beyond content conflicts: "
                f"{applied.stderr or applied.stdout}"
            )
    unstaged = _run_command(["git", "reset"], cwd=workspace, timeout_seconds=60)
    if not unstaged.ok:
        raise AutoDevGitError(
            f"retry patch applied but could not be unstaged: {unstaged.stderr or unstaged.stdout}"
        )
    if conflict_paths:
        marker_paths, unreadable_paths = _inspect_conflict_markers(workspace, conflict_paths)
        if unreadable_paths or set(marker_paths) != set(conflict_paths):
            unsupported = sorted(
                set(unreadable_paths) | (set(conflict_paths) - set(marker_paths))
            )
            raise AutoDevGitError(
                "retry patch produced unsupported conflicts without readable text markers: "
                + ", ".join(unsupported)
            )
    else:
        # A retry of a builder-blocked restoration may carry literal conflict
        # markers in an otherwise cleanly applicable patch. Recover the gate
        # from the restored content instead of silently losing it on attempt 3.
        marker_paths, _ = _inspect_conflict_markers(
            workspace, _changed_worktree_paths(workspace)
        )
        conflict_paths = marker_paths
    return conflict_paths


def _run_one_impl(
    config: AutoDevConfig,
    *,
    task_id: str = "",
    dry_run: bool = False,
    run_id: str = "",
    steer_text: str = "",
    retry_context: str = "",
    retry_from_run_id: str = "",
    queue_port: QueuePort | None = None,
    supervisor_pid: int | None = None,
    defer_landing: bool = False,
    capacity_cancel_event: Any = None,
    _lifecycle: _ClaimLifecycle,
) -> ControllerResult:
    queue_port = queue_port or create_queue_port(config)
    run_id = run_id or _new_run_id()
    _lifecycle.run_id = run_id
    create_run(config, run_id, initial={"supervisor_pid": int(supervisor_pid or 0)})
    _mark_run(config, run_id, status="preflight")

    preflight_ok, preflight, errors = _preflight(config, run_id, dry_run=dry_run)
    base_sha = str(preflight.get("base_sha") or "")
    handoff_context = latest_handoff_excerpt(config)
    if not preflight_ok:
        return _fail(config, run_id, queue_port=queue_port, status="preflight_failed", message="; ".join(errors))
    _mark_run(config, run_id, status="selecting", base_sha=base_sha)

    candidate = _select_task(config, task_id, queue_port)
    if not candidate:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="no_ready_task",
            message="没有可领取的 pending 任务",
        )
    candidate_id = str(candidate.get("id") or "")
    raw_candidate = candidate.get("raw") if isinstance(candidate.get("raw"), dict) else candidate
    prior_failures = int((raw_candidate or {}).get("autodev_failure_count") or 0)
    effective_retry_from_run_id = retry_from_run_id
    if prior_failures >= config.policy.same_task_failures_before_block:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="failure_budget_exhausted",
            task_id=candidate_id,
            block_task=True,
            force_reconcile_block=True,
            record_task_failure=False,
            message=(
                f"task {candidate_id} exhausted AutoDev failure budget "
                f"({prior_failures}/{config.policy.same_task_failures_before_block}); "
                "a human must reset the budget with an audit note before another retry"
            ),
        )
    if prior_failures and not retry_context.strip() and not effective_retry_from_run_id:
        if supervisor_pid is not None:
            last_failure = (raw_candidate or {}).get("last_autodev_failure") or {}
            effective_retry_from_run_id = str(last_failure.get("run_id") or "")
        if not effective_retry_from_run_id:
            return _fail(
                config,
                run_id,
                queue_port=queue_port,
                status="retry_source_required",
                task_id=candidate_id,
                message=(
                    f"task {candidate_id} has {prior_failures} prior AutoDev failure(s); "
                    "standalone run-one must use --retry-from <failed-run-id> so the candidate "
                    "and review findings are preserved"
                ),
            )

    retry_patch_path: Path | None = None
    effective_retry_context = retry_context
    if effective_retry_from_run_id:
        try:
            source_context, retry_patch_path = _standalone_retry_source(
                config,
                task_id=candidate_id,
                source_run_id=effective_retry_from_run_id,
                next_attempt=prior_failures + 1,
            )
        except (OSError, ValueError, AutoDevGitError, yaml.YAMLError, json.JSONDecodeError) as exc:
            return _fail(
                config,
                run_id,
                queue_port=queue_port,
                status="retry_source_invalid",
                task_id=candidate_id,
                message=str(exc),
            )
        effective_retry_context = "\n\n".join(
            item for item in (retry_context.strip(), source_context.strip()) if item
        )

    # Base-ref queue membership gate (H-446): the worktree is built from base_ref, so a
    # task that lives only in an uncommitted main-queue edit is missing from the worktree
    # queue and gets mis-flagged as queue_contract_red after the builder already did valid
    # work. Only relevant in worktree mode (non-isolated runs skip workspace drift). Fail
    # loud here with an actionable "commit the queue" hint, before claim/worktree/builder.
    if config.branch.worktree.enabled:
        membership_error = _base_queue_membership_error(config, base_sha, candidate_id)
        if membership_error:
            append_event(
                config.project.repo_root,
                run_id,
                level="error",
                phase="preflight",
                task_id=candidate_id,
                message=membership_error,
            )
            return _fail(
                config,
                run_id,
                queue_port=queue_port,
                status="queue_not_committed_to_base",
                task_id=candidate_id,
                message=membership_error,
            )

    try:
        selection = resolve_agent_selection(config, candidate)
    except AgentSelectionError as exc:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="agent_selection_failed",
            task_id=candidate_id,
            message=str(exc),
        )
    if not _resolve_executable(selection.builder.command, config.project.repo_root):
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="builder_unavailable",
            task_id=candidate_id,
            message=f"selected builder command not found: {selection.builder.command}",
        )

    if dry_run:
        task = candidate
        selected_task_id = candidate_id
        _record_agent_selection(config, run_id, selected_task_id, selection)
        prompt = build_builder_prompt(
            config,
            task,
            run_id=run_id,
            base_sha=base_sha,
            builder=selection.builder,
            builder_name=selection.builder_name,
            steer_text=steer_text,
            retry_context=effective_retry_context,
            handoff_context=handoff_context,
        )
        prompt_path = _write_task_artifact(config, run_id, selected_task_id, "prompt.md", prompt)
        append_event(
            config.project.repo_root,
            run_id,
            level="info",
            phase="dry_run",
            task_id=selected_task_id,
            message="prompt generated; builder not invoked",
            artifact=str(prompt_path),
            extra=selection.to_event_dict(),
        )
        _mark_run(config, run_id, status="dry_run", task_id=selected_task_id, task_status="selected")
        return ControllerResult(
            ok=True,
            status="dry_run",
            message="dry-run prompt generated",
            run_id=run_id,
            task_id=selected_task_id,
            prompt_path=prompt_path,
        )

    try:
        host_policy = load_host_policy()
    except HostCapacityError as exc:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="host_capacity_invalid",
            task_id=candidate_id,
            message=str(exc),
        )
    if host_policy is None and config.execution.max_parallel_tasks > 1:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="host_policy_required",
            task_id=candidate_id,
            message=(
                "execution.max_parallel_tasks > 1 requires the XDG AutoDev host policy"
            ),
        )
    if host_policy is not None:
        _mark_run(
            config,
            run_id,
            status="waiting_capacity",
            task_id=candidate_id,
            task_status="waiting_capacity",
        )
        broker = create_host_capacity_broker(host_policy)
        try:
            capacity = broker.acquire(
                project_id=config.project.id,
                worker_id=run_id,
                run_id=run_id,
                provider=selection.builder.kind,
                resources=list(candidate.get("exclusive_resources") or []),
                supervisor_pid=supervisor_pid,
                cancel_requested=(
                    capacity_cancel_event.is_set
                    if capacity_cancel_event is not None
                    else None
                ),
            )
        except HostCapacityUnavailable as exc:
            if capacity_cancel_event is not None and capacity_cancel_event.is_set():
                capacity_status = "cancelled_by_breaker"
            elif host_policy.global_stop_file.exists():
                capacity_status = "global_stop_file"
            else:
                capacity_status = "waiting_capacity"
            return _fail(
                config,
                run_id,
                queue_port=queue_port,
                status=capacity_status,
                task_id=candidate_id,
                message=str(exc),
            )
        _lifecycle.bind_capacity(capacity)

    adapter = queue_port
    claim = adapter.claim(
        candidate_id,
        owner="autodev",
        note=f"AutoDev run-one {run_id}",
        lease_token=(
            _lifecycle.capacity_lease.token if _lifecycle.capacity_lease is not None else ""
        ),
    )
    if not claim.ok or not claim.task:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status=claim.status,
            task_id=candidate_id,
            message=claim.message or "claim failed",
        )
    task = claim.task
    selected_task_id = str(task.get("id") or "")
    try:
        claim_lease = ClaimLease.from_task(task)
    except ValueError as exc:
        message = f"invalid queue claim lease: {exc}; explicit manual reconcile required"
        _mark_run(
            config,
            run_id,
            status="system_error",
            task_id=selected_task_id,
            task_status="system_error",
            message=message,
            failure_delta=1,
        )
        append_event(
            config.project.repo_root,
            run_id,
            level="error",
            phase="system_error",
            task_id=selected_task_id,
            message=message,
        )
        return ControllerResult(
            ok=False,
            status="system_error",
            message=message,
            run_id=run_id,
            task_id=selected_task_id,
        )
    bound_port = _LeaseBoundQueuePort(queue_port, claim_lease)
    _lifecycle.bind(run_id, selected_task_id, bound_port)
    _record_claim(config, run_id, claim_lease)
    queue_port = bound_port
    adapter = bound_port
    append_event(
        config.project.repo_root,
        run_id,
        level="info",
        phase="claim",
        task_id=selected_task_id,
        message="task claimed",
    )

    try:
        workspace = prepare_worktree(config, run_id)
    except AutoDevGitError as exc:
        return _release_claim_failure(
            config,
            run_id,
            lifecycle=_lifecycle,
            status="worktree_failed",
            message=str(exc),
        )
    candidate_base = _git_at(workspace.path, "rev-parse", "HEAD")
    if not candidate_base.ok or not candidate_base.stdout.strip():
        return _release_claim_failure(
            config,
            run_id,
            lifecycle=_lifecycle,
            status="worktree_failed",
            message=f"cannot resolve candidate base commit: {candidate_base.stderr or candidate_base.stdout}",
        )
    candidate_base_sha = candidate_base.stdout.strip()
    _record_workspace(
        config,
        run_id,
        workspace,
        candidate_base_sha=candidate_base_sha,
    )
    append_event(
        config.project.repo_root,
        run_id,
        level="info",
        phase="worktree",
        message="worktree ready" if workspace.isolated else "using main workspace",
        artifact=str(workspace.path),
        extra={"branch": workspace.branch, "base_sha": workspace.base_sha, "isolated": workspace.isolated},
    )

    if workspace.isolated:
        workspace_error = _workspace_queue_membership_error(
            config, workspace, selected_task_id
        )
        if workspace_error:
            append_event(
                config.project.repo_root,
                run_id,
                level="error",
                phase="worktree",
                task_id=selected_task_id,
                message=workspace_error,
            )
            return _release_claim_failure(
                config,
                run_id,
                lifecycle=_lifecycle,
                status="workspace_queue_stale",
                message=workspace_error,
            )
    retry_conflicts: list[str] = []
    if retry_patch_path is not None:
        try:
            retry_conflicts = _apply_retry_patch(workspace.path, retry_patch_path)
        except (OSError, AutoDevGitError) as exc:
            return _release_claim_failure(
                config,
                run_id,
                lifecycle=_lifecycle,
                status="retry_patch_failed",
                message=str(exc),
            )

        def record_retry(run: dict[str, Any]) -> None:
            run["retry"] = {
                "source_run_id": effective_retry_from_run_id,
                "patch_path": str(retry_patch_path),
                "attempt": prior_failures + 1,
                "conflict_paths": retry_conflicts,
            }

        mutate_run(config.project.repo_root, run_id, record_retry)
        if retry_conflicts:
            conflict_list = "\n".join(f"- {path}" for path in retry_conflicts)
            effective_retry_context = "\n\n".join(
                item
                for item in (
                    effective_retry_context.strip(),
                    (
                        "### Restored Candidate Conflicts\n"
                        "The prior candidate was restored against the newer integration base. "
                        "Resolve every conflict marker below while preserving both the landed "
                        "changes and the candidate intent before running verification:\n"
                        f"{conflict_list}"
                    ),
                )
                if item
            )
        append_event(
            config.project.repo_root,
            run_id,
            level="info",
            phase="retry_restore",
            task_id=selected_task_id,
            message=(
                f"restored candidate from {effective_retry_from_run_id} with builder-resolvable conflicts"
                if retry_conflicts
                else f"restored candidate from {effective_retry_from_run_id}"
            ),
            artifact=str(retry_patch_path),
            extra={"conflict_paths": retry_conflicts},
        )
    _mark_run(config, run_id, status="building_prompt", task_id=selected_task_id, task_status="in_progress")
    _record_agent_selection(config, run_id, selected_task_id, selection)
    append_event(
        config.project.repo_root,
        run_id,
        level="info",
        phase="agent_selection",
        task_id=selected_task_id,
        message=f"builder={selection.builder_name}; evaluator={selection.evaluator_name}",
        extra=selection.to_event_dict(),
    )
    prompt = build_builder_prompt(
        config,
        task,
        run_id=run_id,
        base_sha=candidate_base_sha,
        workspace_path=workspace.path,
        builder=selection.builder,
        builder_name=selection.builder_name,
        steer_text=steer_text,
        retry_context=effective_retry_context,
        handoff_context=handoff_context,
    )
    prompt_path = _write_task_artifact(config, run_id, selected_task_id, "prompt.md", prompt)
    append_event(
        config.project.repo_root,
        run_id,
        level="info",
        phase="prompt",
        task_id=selected_task_id,
        message="builder prompt generated",
        artifact=str(prompt_path),
    )

    builder = selection.builder
    command = _builder_command(builder, verify_commands_for_task(task, config.verify.default))
    current_builder = selection.to_event_dict()["builder"]
    affinity_reason = ""
    resume_session_id = ""
    if effective_retry_from_run_id and config.policy.builder_session_retry == "prefer_resume":
        affinity_supported, capability_reason = session_capability(builder, command)
        if affinity_supported:
            source_builder_log = (
                run_paths(config.project.repo_root, effective_retry_from_run_id).tasks_dir
                / selected_task_id
                / "builder.json"
            )
            affinity = retry_session_candidate(
                source_builder_log,
                current_agent=current_builder,
                source_run_id=effective_retry_from_run_id,
            )
            resume_session_id = affinity.session_id
            affinity_reason = affinity.reason
        else:
            affinity_reason = capability_reason
    elif effective_retry_from_run_id:
        affinity_reason = "policy.builder_session_retry=fresh"
    else:
        affinity_reason = "initial task attempt"
    _record_builder_session(
        config,
        run_id,
        {
            "mode": "resumed" if resume_session_id else "fresh",
            "session_id": resume_session_id,
            "source_session_id": resume_session_id,
            "source_run_id": effective_retry_from_run_id,
            "resume_attempted": bool(resume_session_id),
            "fallback_reason": "",
            "affinity_reason": affinity_reason,
        },
    )
    _mark_run(config, run_id, status="builder_running", task_id=selected_task_id, task_status="builder_running")
    append_event(
        config.project.repo_root,
        run_id,
        level="info",
        phase="builder",
        task_id=selected_task_id,
        message=(
            "builder resumed previous session"
            if resume_session_id
            else "builder fresh session started"
        ),
        extra={
            "name": selection.builder_name,
            "command": command,
            "fresh_session": builder.fresh_session_per_task,
            "session_mode": "resumed" if resume_session_id else "fresh",
            "source_run_id": effective_retry_from_run_id,
            "affinity_reason": affinity_reason,
        },
    )
    builder_execution = _run_builder_with_session_affinity(
        builder,
        command,
        cwd=workspace.path,
        timeout_seconds=_timeout_seconds(builder.timeout_minutes, 30),
        prompt=prompt,
        resume_session_id=resume_session_id,
        source_run_id=effective_retry_from_run_id,
        affinity_reason=affinity_reason,
    )
    builder_result = builder_execution.result
    _record_builder_session(config, run_id, builder_execution.session)
    if len(builder_execution.attempts) > 1:
        append_event(
            config.project.repo_root,
            run_id,
            level="warning",
            phase="builder_session_fallback",
            task_id=selected_task_id,
            message="builder session resume failed; continued in a fresh session",
            extra={
                "source_session_id": resume_session_id,
                "reason": builder_execution.session.get("fallback_reason") or "resume failed",
            },
        )
    builder_log = {
        "agent": current_builder,
        "command": builder_result.command,
        "returncode": builder_result.returncode,
        "timed_out": builder_result.timed_out,
        "stdout": builder_result.stdout,
        "stderr": builder_result.stderr,
        "session": builder_execution.session,
        "attempts": builder_execution.attempts,
    }
    builder_log_path = _write_task_artifact(
        config,
        run_id,
        selected_task_id,
        "builder.json",
        json.dumps(builder_log, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
    append_event(
        config.project.repo_root,
        run_id,
        level="info" if builder_result.ok else "error",
        phase="builder",
        task_id=selected_task_id,
        message="builder finished" if builder_result.ok else "builder failed",
        artifact=str(builder_log_path),
        extra={
            "returncode": builder_result.returncode,
            "timed_out": builder_result.timed_out,
            "session_mode": builder_execution.session.get("mode"),
            "session_id": builder_execution.session.get("session_id"),
        },
    )
    if _lifecycle.capacity_lease is not None:
        try:
            _lifecycle.capacity_lease.transition_provider("")
        except HostCapacityError as exc:
            return _fail(
                config,
                run_id,
                queue_port=queue_port,
                status="provider_capacity_failed",
                task_id=selected_task_id,
                message=str(exc),
                block_task=True,
            )
    if builder_result.timed_out:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="builder_timeout",
            task_id=selected_task_id,
            message=f"builder timeout after {builder.timeout_minutes or 30} minutes",
            block_task=True,
        )
    if builder_result.returncode is None:
        return _release_claim_failure(
            config,
            run_id,
            lifecycle=_lifecycle,
            status="builder_unavailable",
            message=builder_result.stderr or "builder process could not be launched",
        )
    if not builder_result.ok:
        limit_status, limit_message = _classify_agent_limit(
            builder_result.stdout,
            builder_result.stderr,
        )
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status=limit_status or "builder_failed",
            task_id=selected_task_id,
            message=limit_message or f"builder exited with {builder_result.returncode}",
            block_task=True,
        )

    marker_status, marker_message = _parse_builder_result(builder_result.stdout, builder_result.stderr)
    if marker_status == "blocked":
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="builder_blocked",
            task_id=selected_task_id,
            message=marker_message or "builder reported blocked",
            block_task=True,
        )
    if marker_status != "done":
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="builder_no_result",
            task_id=selected_task_id,
            message="builder did not emit AUTODEV_RESULT: done",
            block_task=True,
        )

    unresolved_markers, unreadable_conflicts = _inspect_conflict_markers(
        workspace.path, retry_conflicts
    )
    unresolved_retry_conflicts = sorted(set(unresolved_markers) | set(unreadable_conflicts))
    if unresolved_retry_conflicts:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="builder_blocked",
            task_id=selected_task_id,
            message=(
                "builder reported done but restored conflict markers remain in: "
                + ", ".join(unresolved_retry_conflicts)
            ),
            block_task=True,
        )

    safety_errors = check_project_safety_policy(
        config,
        repo_root=workspace.path,
        base_ref=candidate_base_sha,
    )
    if safety_errors:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="safety_policy_red",
            task_id=selected_task_id,
            message="post-build safety policy failed: " + "; ".join(safety_errors),
            block_task=True,
        )

    drift = _task_contract_drift(config, task, workspace)
    if drift:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="queue_contract_red",
            task_id=selected_task_id,
            message="queue task acceptance/verify changed: " + ", ".join(drift),
            block_task=True,
        )

    verify_commands = verify_commands_for_task(task, config.verify.default)
    _mark_run(config, run_id, status="verifying", task_id=selected_task_id, task_status="verifying")
    verify_result = run_verify_gate(
        verify_commands,
        cwd=workspace.path,
        timeout_seconds=_timeout_seconds(config.verify.command_timeout_minutes, 10),
        artifact_dir=_task_artifact_dir(config, run_id, selected_task_id),
    )
    append_event(
        config.project.repo_root,
        run_id,
        level="info" if verify_result.ok else "error",
        phase="verify",
        task_id=selected_task_id,
        message="verify passed" if verify_result.ok else "verify failed",
        artifact=str(verify_result.evidence_path),
        extra={"summary": str(verify_result.summary_path or "")},
    )
    if not verify_result.ok:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="verify_failed",
            task_id=selected_task_id,
            message=f"verify failed; summary={verify_result.summary_path}",
            block_task=True,
        )

    drift = _task_contract_drift(config, task, workspace)
    if drift:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="queue_contract_red",
            task_id=selected_task_id,
            message="queue task acceptance/verify changed before done: " + ", ".join(drift),
            block_task=True,
        )

    evaluator = selection.evaluator
    try:
        diff_text = _prepare_review_diff(
            config,
            run_id,
            selected_task_id,
            workspace.path,
            candidate_base_sha,
        )
    except AutoDevGitError as exc:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="review_diff_failed",
            task_id=selected_task_id,
            message=str(exc),
            block_task=True,
        )
    if _lifecycle.capacity_lease is not None:
        _mark_run(
            config,
            run_id,
            status="waiting_provider",
            task_id=selected_task_id,
            task_status="waiting_provider",
        )
        try:
            _lifecycle.capacity_lease.transition_provider(evaluator.kind)
        except HostCapacityError as exc:
            return _fail(
                config,
                run_id,
                queue_port=queue_port,
                status="provider_capacity_failed",
                task_id=selected_task_id,
                message=str(exc),
                block_task=True,
            )
    _mark_run(config, run_id, status="reviewing", task_id=selected_task_id, task_status="reviewing")
    try:
        evaluation = run_evaluator_gate(
            build_agent_argv(evaluator, role="checker", verify_commands=config.verify.default),
            cwd=workspace.path,
            timeout_seconds=_timeout_seconds(evaluator.timeout_minutes, 10),
            artifact_dir=_task_artifact_dir(config, run_id, selected_task_id),
            task=task,
            run_id=run_id,
            builder_message=marker_message,
            verify_evidence=verify_result.to_dict(),
            diff_text=diff_text,
        )
    finally:
        if _lifecycle.capacity_lease is not None:
            try:
                _lifecycle.capacity_lease.transition_provider("")
            except HostCapacityError:
                pass
    review_extra = evaluation.to_dict()
    review_extra["agent_selection"] = selection.to_event_dict()
    append_event(
        config.project.repo_root,
        run_id,
        level="error" if evaluation.should_block else "info",
        phase="review",
        task_id=selected_task_id,
        message=f"review {evaluation.status}: {evaluation.message}",
        artifact=str(evaluation.review_yaml_path),
        extra=review_extra,
    )
    if evaluation.should_block:
        status = "review_red" if evaluation.status == "red" else "review_blocked"
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status=status,
            task_id=selected_task_id,
            message=evaluation.message or "review blocked",
            block_task=True,
        )
    try:
        current_diff = _candidate_review_diff(workspace.path, candidate_base_sha)
    except AutoDevGitError as exc:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="review_diff_failed",
            task_id=selected_task_id,
            message=str(exc),
            block_task=True,
        )
    if current_diff != diff_text:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="review_candidate_changed",
            task_id=selected_task_id,
            message="candidate tree changed after evaluator review; refusing to commit unreviewed content",
            block_task=True,
        )
    safety_errors = check_project_safety_policy(
        config,
        repo_root=workspace.path,
        base_ref=candidate_base_sha,
    )
    if safety_errors:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="safety_policy_red",
            task_id=selected_task_id,
            message="pre-commit safety policy failed: " + "; ".join(safety_errors),
            block_task=True,
        )
    try:
        commit_sha = (
            commit_candidate_checkpoint(config, workspace, task, verify_result)
            if defer_landing
            else commit_checkpoint(config, workspace, task, verify_result)
        )
    except AutoDevGitError as exc:
        return _fail(
            config,
            run_id,
            queue_port=queue_port,
            status="commit_failed",
            task_id=selected_task_id,
            message=str(exc),
            block_task=True,
        )
    _record_commit(config, run_id, commit_sha)
    append_event(
        config.project.repo_root,
        run_id,
        level="info",
        phase="commit",
        task_id=selected_task_id,
        message="checkpoint committed" if commit_sha else "no changes to commit",
        extra={"commit": commit_sha, "branch": workspace.branch},
    )
    if defer_landing:
        _mark_run(
            config,
            run_id,
            status="candidate_ready",
            task_id=selected_task_id,
            task_status="candidate_ready",
        )
        append_event(
            config.project.repo_root,
            run_id,
            level="info",
            phase="candidate_ready",
            task_id=selected_task_id,
            message="reviewed candidate is waiting for the project landing lane",
            extra={"commit": commit_sha, "integration_base_sha": workspace.integration_base_sha},
        )
        return ControllerResult(
            ok=True,
            status="candidate_ready",
            message=marker_message or "candidate reviewed and ready to land",
            run_id=run_id,
            task_id=selected_task_id,
            prompt_path=prompt_path,
        )
    done = adapter.done(
        selected_task_id,
        note=f"AutoDev run-one {run_id}: {marker_message or 'builder done; verify passed'}",
        artifacts=[
            str(prompt_path),
            str(builder_log_path),
            str(verify_result.evidence_path),
            str(evaluation.review_md_path),
            str(evaluation.review_yaml_path),
        ],
    )
    if not done.ok:
        return _lifecycle.settle_message(
            f"queue finalize failed ({done.status}): {done.message or 'unknown error'}"
        )
    _lifecycle.mark_finalized()
    # The checkpoint and queue CAS are authoritative at this point. Local
    # journal/handoff failures (for example ENOSPC during an overnight run)
    # must remain visible in the returned message, but cannot turn an already
    # committed + finalized task into a false system_error.
    journal_errors: list[str] = []
    try:
        _mark_run(
            config,
            run_id,
            status="done",
            task_id=selected_task_id,
            task_status="done",
            message="",
            done_delta=1,
        )
    except Exception as exc:
        journal_errors.append(f"run journal: {type(exc).__name__}: {exc}")
    try:
        append_event(
            config.project.repo_root,
            run_id,
            level="info",
            phase="done",
            task_id=selected_task_id,
            message="task done",
        )
    except Exception as exc:
        journal_errors.append(f"completion event: {type(exc).__name__}: {exc}")
    try:
        _write_task_handoff_safe(config, run_id, selected_task_id, queue_port)
    except Exception as exc:
        journal_errors.append(f"task handoff: {type(exc).__name__}: {exc}")
    result_message = marker_message or "builder done; verify passed"
    if journal_errors:
        result_message += "; completion journal warning after queue finalization: " + "; ".join(journal_errors)
    return ControllerResult(
        ok=True,
        status="done",
        message=result_message,
        run_id=run_id,
        task_id=selected_task_id,
        prompt_path=prompt_path,
    )


def run_one(
    config: AutoDevConfig,
    *,
    task_id: str = "",
    dry_run: bool = False,
    run_id: str = "",
    steer_text: str = "",
    retry_context: str = "",
    retry_from_run_id: str = "",
    queue_port: QueuePort | None = None,
    supervisor_pid: int | None = None,
    defer_landing: bool = False,
    capacity_cancel_event: Any = None,
) -> ControllerResult:
    run_id = validate_run_id(run_id or _new_run_id())
    lifecycle = _ClaimLifecycle(config)
    with RunHeartbeat(config.project.repo_root, config.project.id, run_id):
        try:
            return _run_one_impl(
                config,
                task_id=task_id,
                dry_run=dry_run,
                run_id=run_id,
                steer_text=steer_text,
                retry_context=retry_context,
                retry_from_run_id=retry_from_run_id,
                queue_port=queue_port,
                supervisor_pid=supervisor_pid,
                defer_landing=defer_landing,
                capacity_cancel_event=capacity_cancel_event,
                _lifecycle=lifecycle,
            )
        except BaseException as exc:
            if not lifecycle.claimed:
                raise
            settled = lifecycle.settle_exception(exc)
            if not isinstance(exc, Exception):
                raise
            return settled
        finally:
            lifecycle.close_capacity()


def _repo_path(config: AutoDevConfig, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return config.project.repo_root / path


def _stop_file(config: AutoDevConfig) -> Path:
    return _repo_path(config, config.policy.stop_file)


def _steer_file(config: AutoDevConfig) -> Path:
    return _repo_path(config, config.policy.steer_file)


def _read_and_archive_steer(config: AutoDevConfig, loop_run_id: str, index: int) -> tuple[str, Path | None]:
    source = _steer_file(config)
    if not source.exists():
        return "", None
    text = source.read_text(encoding="utf-8")
    archive_dir = run_paths(config.project.repo_root, loop_run_id).run_dir / "steer"
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive = archive_dir / f"steer_{index:02d}.md"
    atomic_write_text(archive, text)
    source.unlink()
    append_event(
        config.project.repo_root,
        loop_run_id,
        level="info",
        phase="steer",
        message="STEER.md injected into next task prompt and archived",
        artifact=str(archive),
    )
    return text, archive


def _task_outcome(config: AutoDevConfig, result: ControllerResult) -> LoopTaskOutcome:
    commit = ""
    worktree_path = ""
    try:
        run = load_run(config.project.repo_root, result.run_id)
        current = run.get("current_task") or {}
        git = run.get("git") or {}
        commit = str(current.get("commit") or "")
        worktree_path = str(git.get("worktree_path") or "")
    except Exception:
        pass
    return LoopTaskOutcome(
        run_id=result.run_id,
        task_id=result.task_id,
        status=result.status,
        ok=result.ok,
        message=result.message,
        commit=commit,
        worktree_path=worktree_path,
    )


def _landing_ledger_path(config: AutoDevConfig, task_id: str, run_id: str) -> Path:
    return (
        config.project.repo_root
        / ".autodev"
        / "runtime"
        / "landings"
        / f"{validate_task_id(task_id)}-{validate_run_id(run_id)}.json"
    )


def _database_landing_store(config: AutoDevConfig):
    from autodev.database.config import MODE_DATABASE
    from autodev.database.shadow import resolve_persistence_config

    persistence = resolve_persistence_config()
    if persistence.mode != MODE_DATABASE:
        return None
    from autodev.database.composition import landing_store_for_config

    return landing_store_for_config(config, database_config=persistence)


def _landing_reference(
    config: AutoDevConfig, path: Path, task_id: str, run_id: str
) -> str:
    if _database_landing_store(config) is not None:
        return f"database:landing:{config.project.id}/{task_id}/{run_id}"
    return str(path)


def _write_landing_ledger(
    config: AutoDevConfig,
    path: Path,
    payload: dict[str, Any],
    state: str,
) -> None:
    payload["schema_version"] = 1
    payload["state"] = state
    payload["updated_at"] = datetime.now().astimezone().isoformat()
    store = _database_landing_store(config)
    if store is not None:
        task_id = validate_task_id(str(payload.get("task_id") or ""))
        run_id = validate_run_id(str(payload.get("run_id") or ""))
        if state == "prepared":
            from autodev.persistence import PersistenceConflictError

            try:
                store.prepare(payload)
            except PersistenceConflictError:
                existing = store.get(task_id, run_id)
                if existing.get("state") != "prepared":
                    raise
                old_candidate = str(existing.get("candidate_sha") or "")
                current_ref = str(payload.get("expected_ref") or "")
                contains = _git(
                    config,
                    "merge-base",
                    "--is-ancestor",
                    old_candidate,
                    current_ref,
                )
                if contains.returncode not in {0, 1}:
                    raise
                store.replace_prepared(
                    payload,
                    current_ref=current_ref,
                    previous_candidate_is_ancestor=contains.returncode == 0,
                )
            return
        current = store.get(task_id, run_id)
        current_state = str(current.get("state") or "")
        changes = {
            "pushed": bool(payload.get("pushed")),
            "detail": dict(payload.get("detail") or {}),
        }
        if state == current_state:
            store.update_evidence(
                config.project.id,
                task_id,
                run_id,
                expected_status=current_state,
                changes=changes,
            )
            return
        store.advance(
            config.project.id,
            task_id,
            run_id,
            expected_status=current_state,
            new_status=state,
            changes=changes,
        )
        return
    atomic_write_text(
        path,
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )


def _reconcile_landing_ledgers(config: AutoDevConfig) -> list[str]:
    """Finish or safely resume durable Git/queue landing transactions."""
    store = _database_landing_store(config)
    if store is not None:
        return _reconcile_database_landings(config, store)
    return _reconcile_file_landing_ledgers(config)


def _reconcile_database_landings(config: AutoDevConfig, store) -> list[str]:
    errors: list[str] = []
    for stored in store.pending(config.project.id):
        ledger = dict(stored)
        task_id = str(ledger.get("task_id") or "")
        child_run_id = str(ledger.get("run_id") or "")
        label = f"{task_id}/{child_run_id}"
        try:
            task_id = validate_task_id(task_id)
            child_run_id = validate_run_id(child_run_id)
            branch = str(ledger.get("integration_branch") or "")
            candidate_sha = str(ledger.get("candidate_sha") or "")
            if not branch or not candidate_sha:
                raise ValueError("database landing is missing ref identities")
            current = _git(config, "rev-parse", f"refs/heads/{branch}")
            if not current.ok or not current.stdout.strip():
                raise ValueError(current.stderr or "integration ref is unreadable")
            current_sha = current.stdout.strip()
            contains_candidate = (
                _git(
                    config,
                    "merge-base",
                    "--is-ancestor",
                    candidate_sha,
                    current_sha,
                ).returncode
                == 0
            )
            recovery = store.reconcile_git_fact(
                task_id,
                child_run_id,
                current_ref=current_sha,
                candidate_is_ancestor=contains_candidate,
            )
            if recovery.get("recovery_action") == "resume_prepared":
                resumed = _land_candidate(
                    config,
                    ControllerResult(
                        ok=True,
                        status="candidate_ready",
                        message="resume prepared database landing",
                        run_id=child_run_id,
                        task_id=task_id,
                    ),
                )
                if not resumed.ok:
                    raise ValueError(
                        "prepared landing resume failed: "
                        f"{resumed.status}: {resumed.message}"
                    )
                continue
            if recovery.get("recovery_action") == "retry_prepared":
                claim = ledger.get("queue_claim") or {}
                lease = ClaimLease(
                    task_id=task_id,
                    owner=str(claim.get("owner") or ""),
                    lease_token=str(claim.get("lease_token") or ""),
                    revision=int(claim.get("revision")),
                )
                retry_port = _LeaseBoundQueuePort(
                    create_queue_port(config), lease
                )
                current_task = retry_port.get_task(task_id)
                claim_is_live = (
                    current_task.get("status") == "in_progress"
                    and str(current_task.get("owner") or "") == lease.owner
                    and str(current_task.get("lease_token") or "")
                    == lease.lease_token
                    and int(current_task.get("revision") or 0)
                    == lease.revision
                )
                if claim_is_live:
                    resumed = _land_candidate(
                        config,
                        ControllerResult(
                            ok=True,
                            status="candidate_ready",
                            message="retry losing database landing CAS",
                            run_id=child_run_id,
                            task_id=task_id,
                        ),
                    )
                    if not resumed.ok:
                        raise ValueError(
                            "prepared landing retry failed: "
                            f"{resumed.status}: {resumed.message}"
                        )
                else:
                    store.abandon_prepared(
                        task_id,
                        child_run_id,
                        current_ref=current_sha,
                        candidate_is_ancestor=False,
                    )
                    _mark_run(
                        config,
                        child_run_id,
                        status="integration_cas_failed",
                        task_id=task_id,
                        task_status=str(
                            current_task.get("status") or "blocked"
                        ),
                        message=(
                            "prepared landing retired after its Git CAS lost "
                            "and its Queue claim was no longer active"
                        ),
                    )
                continue
            if bool(ledger.get("push_required")) and not bool(ledger.get("pushed")):
                push = _run_command(
                    ["git", "push", "-u", "origin", branch],
                    cwd=config.project.repo_root,
                    timeout_seconds=300,
                )
                if not push.ok:
                    detail = push.stderr.strip() or push.stdout.strip()
                    raise ValueError(
                        "integration is local but required push still failed: "
                        f"{detail or 'git push failed'}"
                    )
                ledger["pushed"] = True
                store.update_evidence(
                    config.project.id,
                    task_id,
                    child_run_id,
                    expected_status="integrated",
                    changes={"pushed": True},
                )
            claim = ledger.get("queue_claim") or {}
            lease = ClaimLease(
                task_id=task_id,
                owner=str(claim.get("owner") or ""),
                lease_token=str(claim.get("lease_token") or ""),
                revision=int(claim.get("revision")),
            )
            port = _LeaseBoundQueuePort(create_queue_port(config), lease)
            current_task = port.get_task(task_id)
            reference = (
                f"database:landing:{config.project.id}/{task_id}/{child_run_id}"
            )
            if current_task.get("status") != "done":
                done = port.done(
                    task_id,
                    note="AutoDev reconciled database landing",
                    artifacts=[reference],
                )
                if not done.ok:
                    raise ValueError(
                        f"queue finalize failed: {done.status}: {done.message}"
                    )
            _mark_run(
                config,
                child_run_id,
                status="done",
                task_id=task_id,
                task_status="done",
            )
            store.advance(
                config.project.id,
                task_id,
                child_run_id,
                expected_status="integrated",
                new_status="queue_finalized",
            )
        except Exception as exc:
            errors.append(f"{label}: {type(exc).__name__}: {exc}")
    return errors


def _reconcile_file_landing_ledgers(config: AutoDevConfig) -> list[str]:
    root = config.project.repo_root / ".autodev" / "runtime" / "landings"
    if not root.exists():
        return []
    errors: list[str] = []
    for path in sorted(root.glob("*.json")):
        try:
            ledger = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(ledger, dict) or ledger.get("schema_version") != 1:
                raise ValueError("invalid landing ledger schema")
            state = str(ledger.get("state") or "")
            if state == "queue_finalized":
                continue
            task_id = validate_task_id(str(ledger.get("task_id") or ""))
            child_run_id = validate_run_id(str(ledger.get("run_id") or ""))
            branch = str(ledger.get("integration_branch") or "")
            candidate_sha = str(ledger.get("candidate_sha") or "")
            expected_ref = str(ledger.get("expected_ref") or "")
            if not branch or not candidate_sha or not expected_ref:
                raise ValueError("landing ledger is missing ref identities")
            current = _git(config, "rev-parse", f"refs/heads/{branch}")
            if not current.ok or not current.stdout.strip():
                raise ValueError(current.stderr or "integration ref is unreadable")
            current_sha = current.stdout.strip()
            contains_candidate = (
                _git(
                    config,
                    "merge-base",
                    "--is-ancestor",
                    candidate_sha,
                    current_sha,
                ).returncode
                == 0
            )
            if state == "prepared" and current_sha == expected_ref:
                resumed = _land_candidate(
                    config,
                    ControllerResult(
                        ok=True,
                        status="candidate_ready",
                        message="resume prepared landing",
                        run_id=child_run_id,
                        task_id=task_id,
                    ),
                )
                if not resumed.ok:
                    raise ValueError(
                        f"prepared landing resume failed: {resumed.status}: {resumed.message}"
                    )
                continue
            if not contains_candidate:
                raise ValueError(
                    "integration ref is neither the expected pre-CAS ref nor a ref containing the candidate"
                )
            _write_landing_ledger(config, path, ledger, "integrated")
            if bool(ledger.get("push_required")) and not bool(ledger.get("pushed")):
                push = _run_command(
                    ["git", "push", "-u", "origin", branch],
                    cwd=config.project.repo_root,
                    timeout_seconds=300,
                )
                if not push.ok:
                    detail = push.stderr.strip() or push.stdout.strip()
                    raise ValueError(
                        "integration is local but required push still failed: "
                        f"{detail or 'git push failed'}"
                    )
                ledger["pushed"] = True
                _write_landing_ledger(config, path, ledger, "integrated")
            claim = ledger.get("queue_claim") or {}
            lease = ClaimLease(
                task_id=task_id,
                owner=str(claim.get("owner") or ""),
                lease_token=str(claim.get("lease_token") or ""),
                revision=int(claim.get("revision")),
            )
            port = _LeaseBoundQueuePort(create_queue_port(config), lease)
            current_task = port.get_task(task_id)
            if current_task.get("status") != "done":
                done = port.done(
                    task_id,
                    note=f"AutoDev reconciled landing ledger {path.name}",
                    artifacts=[str(path)],
                )
                if not done.ok:
                    raise ValueError(
                        f"queue finalize failed: {done.status}: {done.message}"
                    )
            _mark_run(
                config,
                child_run_id,
                status="done",
                task_id=task_id,
                task_status="done",
            )
            _write_landing_ledger(config, path, ledger, "queue_finalized")
        except Exception as exc:
            errors.append(f"{path.name}: {type(exc).__name__}: {exc}")
    return errors


def _reconcile_orphan_candidates(config: AutoDevConfig) -> list[str]:
    """Adopt reviewed candidates left behind by a dead supervisor.

    A worker deliberately stops at ``candidate_ready``. If its supervisor dies
    before consuming the result artifact there is no landing ledger yet, but
    the exact queue claim and immutable candidate worktree are already durable.
    The next supervisor owns the project loop lease, so it may safely feed
    these candidates through the normal serialized landing path.
    """
    root = config.project.repo_root / ".autodev" / "runs"
    if not root.exists():
        return []
    errors: list[str] = []
    for run_yaml in sorted(root.glob("*/run.yaml")):
        run_id = run_yaml.parent.name
        try:
            child = load_run(config.project.repo_root, run_id)
        except Exception:
            # Historical/corrupt non-candidate runs are outside this recovery
            # transaction. Queue capacity and exact claim checks still prevent
            # an unknown in_progress task from being overwritten.
            continue
        if str(child.get("status") or "") != "candidate_ready":
            continue
        current_task = child.get("current_task") or {}
        task_id = str(current_task.get("id") or "")
        try:
            validate_task_id(task_id)
            claim = _claim_from_child_run(child)
            if claim.task_id != task_id:
                raise ValueError("candidate run task and queue claim do not match")
            task = create_queue_port(config).get_task(task_id)
            if task.get("status") == "done":
                _mark_run(
                    config,
                    run_id,
                    status="done",
                    task_id=task_id,
                    task_status="done",
                )
                continue
            if task.get("status") != "in_progress":
                raise ValueError(
                    f"candidate queue task is {task.get('status')}, expected in_progress"
                )
            if (
                str(task.get("owner") or "") != claim.owner
                or str(task.get("lease_token") or "") != claim.lease_token
                or int(task.get("revision")) != claim.revision
            ):
                raise ValueError("candidate queue lease no longer matches")
            resumed = _land_candidate(
                config,
                ControllerResult(
                    ok=True,
                    status="candidate_ready",
                    message="adopt orphan candidate",
                    run_id=run_id,
                    task_id=task_id,
                ),
            )
            if not resumed.ok:
                raise ValueError(
                    f"candidate landing failed: {resumed.status}: {resumed.message}"
                )
        except Exception as exc:
            errors.append(f"{run_id}: {type(exc).__name__}: {exc}")
    return errors


def _claim_from_child_run(run: dict[str, Any]) -> ClaimLease:
    claim = run.get("queue_claim") or {}
    return ClaimLease(
        task_id=str(claim.get("task_id") or ""),
        owner=str(claim.get("owner") or ""),
        lease_token=str(claim.get("lease_token") or ""),
        revision=int(claim.get("revision")),
    )


def _landing_failure(
    config: AutoDevConfig,
    result: ControllerResult,
    port: _LeaseBoundQueuePort,
    *,
    status: str,
    message: str,
) -> ControllerResult:
    blocked = port.block(
        result.task_id,
        reason=message,
        next_action="检查 landing 证据并人工恢复",
        failure_status=status,
        failure_run_id=result.run_id,
    )
    final_status = status
    if not blocked.ok:
        final_status = "system_error"
        message = (
            f"{message}; landing queue block failed ({blocked.status}): "
            f"{blocked.message}; explicit reconcile required"
        )
    _mark_run(
        config,
        result.run_id,
        status=final_status,
        task_id=result.task_id,
        task_status="blocked" if blocked.ok else "system_error",
        message=message,
        blocked_delta=1 if blocked.ok else 0,
        failure_delta=1,
    )
    append_event(
        config.project.repo_root,
        result.run_id,
        level="error",
        phase=final_status,
        task_id=result.task_id,
        message=message,
    )
    return ControllerResult(
        ok=False,
        status=final_status,
        message=message,
        run_id=result.run_id,
        task_id=result.task_id,
        prompt_path=result.prompt_path,
    )


def _land_candidate(config: AutoDevConfig, result: ControllerResult) -> ControllerResult:
    """Run parent-owned landing with an exact child-run heartbeat."""
    with RunHeartbeat(config.project.repo_root, config.project.id, result.run_id):
        return _land_candidate_impl(config, result)


def _land_candidate_impl(config: AutoDevConfig, result: ControllerResult) -> ControllerResult:
    """Serialize final verify/re-review/ref CAS/queue CAS for one candidate."""
    child_run = load_run(config.project.repo_root, result.run_id)
    git = child_run.get("git") or {}
    claim = _claim_from_child_run(child_run)
    queue_port = _LeaseBoundQueuePort(create_queue_port(config), claim)
    task = queue_port.get_task(result.task_id)
    workspace = WorktreeContext(
        path=Path(str(git.get("worktree_path") or "")),
        branch=str(git.get("branch") or ""),
        base_ref=str(git.get("base_ref") or config.branch.base_ref),
        base_sha=str(git.get("base_sha") or ""),
        isolated=True,
        integration_branch=str(git.get("integration_branch") or ""),
        integration_base_sha=str(git.get("integration_base_sha") or ""),
    )
    if not workspace.path.is_dir() or not workspace.integration_branch:
        return _landing_failure(
            config,
            result,
            queue_port,
            status="landing_state_invalid",
            message="candidate worktree or integration branch is missing",
        )

    capacity: HostCapacityLease | None = None
    try:
        policy = load_host_policy()
        if policy is not None:
            capacity = create_host_capacity_broker(policy).acquire(
                project_id=config.project.id,
                worker_id=f"landing:{result.run_id}",
                run_id=result.run_id,
                resources=list(task.get("exclusive_resources") or []),
                supervisor_pid=os.getpid(),
            )
    except HostCapacityError as exc:
        return _landing_failure(
            config,
            result,
            queue_port,
            status="landing_capacity_failed",
            message=str(exc),
        )

    try:
        with file_lock(landing_lane_path(config.project.repo_root)):
            current_ref = _git(
                config,
                "rev-parse",
                f"refs/heads/{workspace.integration_branch}",
            )
            if not current_ref.ok or not current_ref.stdout.strip():
                return _landing_failure(
                    config,
                    result,
                    queue_port,
                    status="landing_state_invalid",
                    message=current_ref.stderr or "cannot resolve integration branch",
                )
            expected_head = current_ref.stdout.strip()
            rebased = expected_head != workspace.integration_base_sha
            if rebased:
                rebase = _git_at(workspace.path, "rebase", expected_head)
                if not rebase.ok:
                    _git_at(workspace.path, "rebase", "--abort")
                    return _landing_failure(
                        config,
                        result,
                        queue_port,
                        status="integration_conflict",
                        message=(
                            rebase.stderr.strip()
                            or rebase.stdout.strip()
                            or "candidate conflicts with the current integration branch"
                        ),
                    )
            head = _git_at(workspace.path, "rev-parse", "HEAD")
            if not head.ok or not head.stdout.strip():
                return _landing_failure(
                    config,
                    result,
                    queue_port,
                    status="landing_state_invalid",
                    message=head.stderr or "cannot resolve candidate commit",
                )
            candidate_sha = head.stdout.strip()
            _record_commit(config, result.run_id, candidate_sha)
            artifact_dir = _task_artifact_dir(
                config, result.run_id, result.task_id
            ) / "landing"
            _mark_run(
                config,
                result.run_id,
                status="landing_verifying",
                task_id=result.task_id,
                task_status="landing_verifying",
            )
            verify = run_verify_gate(
                verify_commands_for_task(task, config.verify.default),
                cwd=workspace.path,
                timeout_seconds=_timeout_seconds(
                    config.verify.command_timeout_minutes, 10
                ),
                artifact_dir=artifact_dir,
            )
            if not verify.ok:
                return _landing_failure(
                    config,
                    result,
                    queue_port,
                    status="landing_verify_failed",
                    message=f"final landing verify failed: {verify.summary_path}",
                )
            safety_errors = check_project_safety_policy(
                config, repo_root=workspace.path, base_ref=expected_head
            )
            if safety_errors:
                return _landing_failure(
                    config,
                    result,
                    queue_port,
                    status="landing_safety_policy_red",
                    message="; ".join(safety_errors),
                )

            review_artifacts: list[str] = []
            if rebased:
                try:
                    selection = resolve_agent_selection(config, task)
                    if capacity is not None:
                        _mark_run(
                            config,
                            result.run_id,
                            status="landing_waiting_provider",
                            task_id=result.task_id,
                            task_status="landing_waiting_provider",
                        )
                        capacity.transition_provider(
                            selection.evaluator.kind,
                            priority=0,
                        )
                    diff_text = _candidate_review_diff(workspace.path, expected_head)
                    evaluation = run_evaluator_gate(
                        build_agent_argv(
                            selection.evaluator,
                            role="checker",
                            verify_commands=config.verify.default,
                        ),
                        cwd=workspace.path,
                        timeout_seconds=_timeout_seconds(
                            selection.evaluator.timeout_minutes, 10
                        ),
                        artifact_dir=artifact_dir / "re_review",
                        task=task,
                        run_id=result.run_id,
                        builder_message="candidate rebased onto latest integration head",
                        verify_evidence=verify.to_dict(),
                        diff_text=diff_text,
                    )
                except (AgentSelectionError, HostCapacityError, AutoDevGitError) as exc:
                    return _landing_failure(
                        config,
                        result,
                        queue_port,
                        status="landing_review_failed",
                        message=str(exc),
                    )
                finally:
                    if capacity is not None:
                        try:
                            capacity.transition_provider("")
                        except HostCapacityError:
                            pass
                review_artifacts = [
                    str(evaluation.review_md_path),
                    str(evaluation.review_yaml_path),
                ]
                if evaluation.should_block:
                    return _landing_failure(
                        config,
                        result,
                        queue_port,
                        status="landing_review_red",
                        message=evaluation.message or "rebased candidate review blocked",
                    )

            ledger_path = _landing_ledger_path(
                config, result.task_id, result.run_id
            )
            ledger = {
                "task_id": result.task_id,
                "run_id": result.run_id,
                "integration_branch": workspace.integration_branch,
                "expected_ref": expected_head,
                "candidate_sha": candidate_sha,
                "queue_claim": child_run.get("queue_claim") or {},
                "push_required": bool(config.branch.push),
                "pushed": not bool(config.branch.push),
            }
            _write_landing_ledger(config, ledger_path, ledger, "prepared")
            try:
                advance_integration_ref(
                    config,
                    workspace,
                    candidate_sha,
                    expected_old=expected_head,
                    push=False,
                )
            except AutoDevGitError as exc:
                return _landing_failure(
                    config,
                    result,
                    queue_port,
                    status="integration_cas_failed",
                    message=str(exc),
                )
            _write_landing_ledger(config, ledger_path, ledger, "integrated")
            if config.branch.push:
                push = _run_command(
                    [
                        "git",
                        "push",
                        "-u",
                        "origin",
                        workspace.integration_branch or workspace.branch,
                    ],
                    cwd=config.project.repo_root,
                    timeout_seconds=300,
                )
                if not push.ok:
                    detail = push.stderr.strip() or push.stdout.strip()
                    message = (
                        "integration advanced locally but push failed; "
                        "queue remains in_progress and the integrated landing ledger "
                        f"must be reconciled: {detail or 'git push failed'}"
                    )
                    _mark_run(
                        config,
                        result.run_id,
                        status="landing_finalize_pending",
                        task_id=result.task_id,
                        task_status="landing_finalize_pending",
                        message=message,
                        failure_delta=1,
                    )
                    return ControllerResult(
                        ok=False,
                        status="landing_finalize_pending",
                        message=message,
                        run_id=result.run_id,
                        task_id=result.task_id,
                        prompt_path=result.prompt_path,
                    )
                ledger["pushed"] = True
                _write_landing_ledger(config, ledger_path, ledger, "integrated")
            landing_reference = _landing_reference(
                config, ledger_path, result.task_id, result.run_id
            )
            done = queue_port.done(
                result.task_id,
                note=f"AutoDev landing {result.run_id}: final verify passed",
                artifacts=[
                    str(verify.evidence_path),
                    landing_reference,
                    *review_artifacts,
                ],
            )
            if not done.ok:
                message = (
                    f"integration advanced but queue finalize failed ({done.status}): "
                    f"{done.message}; reconcile landing ledger"
                )
                _mark_run(
                    config,
                    result.run_id,
                    status="landing_finalize_pending",
                    task_id=result.task_id,
                    task_status="landing_finalize_pending",
                    message=message,
                    failure_delta=1,
                )
                return ControllerResult(
                    ok=False,
                    status="landing_finalize_pending",
                    message=message,
                    run_id=result.run_id,
                    task_id=result.task_id,
                    prompt_path=result.prompt_path,
                )
            _mark_run(
                config,
                result.run_id,
                status="done",
                task_id=result.task_id,
                task_status="done",
                done_delta=1,
            )
            _write_landing_ledger(
                config, ledger_path, ledger, "queue_finalized"
            )
            append_event(
                config.project.repo_root,
                result.run_id,
                level="info",
                phase="done",
                task_id=result.task_id,
                message="candidate landed and queue finalized",
                artifact=str(ledger_path),
                extra={"rebased": rebased, "commit": candidate_sha},
            )
            return ControllerResult(
                ok=True,
                status="done",
                message="candidate landed; final verify passed",
                run_id=result.run_id,
                task_id=result.task_id,
                prompt_path=result.prompt_path,
            )
    finally:
        if capacity is not None:
            capacity.close()


def _spawn_worker_attempt(
    config: AutoDevConfig,
    *,
    loop_run_id: str,
    task_id: str,
    child_run_id: str,
    steer_text: str,
    steer_archive: Path | None,
    retry_context: str,
    retry_from_run_id: str,
    retry_attempt: int,
    retry_artifacts: list[str],
    sequence: int,
) -> WorkerAttempt:
    from autodev.worker import run_assigned_task

    worker_dir = run_paths(config.project.repo_root, loop_run_id).run_dir / "workers"
    worker_dir.mkdir(parents=True, exist_ok=True)
    result_path = worker_dir / f"{child_run_id}.result.json"
    context = multiprocessing.get_context("spawn")
    cancel_event = context.Event()
    process = context.Process(
        target=run_assigned_task,
        kwargs={
            "config": config,
            "task_id": task_id,
            "run_id": child_run_id,
            "steer_text": steer_text,
            "retry_context": retry_context,
            "retry_from_run_id": retry_from_run_id,
            "result_path": result_path,
            "supervisor_pid": os.getpid(),
            "capacity_cancel_event": cancel_event,
        },
        name=f"autodev-worker-{task_id}",
        daemon=False,
    )
    process.start()
    return WorkerAttempt(
        task_id=task_id,
        run_id=child_run_id,
        process=process,
        result_path=result_path,
        steer_archive=steer_archive,
        retry_attempt=retry_attempt,
        retry_artifacts=list(retry_artifacts),
        sequence=sequence,
        cancel_event=cancel_event,
    )


def _update_parallel_workers(
    config: AutoDevConfig,
    loop_run_id: str,
    active: dict[str, WorkerAttempt],
    *,
    concurrency: int,
) -> None:
    workers: list[dict[str, Any]] = []
    for attempt in sorted(active.values(), key=lambda item: item.sequence):
        status = "starting"
        try:
            child = load_run(config.project.repo_root, attempt.run_id)
            status = str(child.get("status") or status)
        except (FileNotFoundError, ValueError):
            pass
        workers.append(
            {
                "worker_id": f"worker-{attempt.sequence:02d}",
                "task_id": attempt.task_id,
                "child_run_id": attempt.run_id,
                "status": status,
                "pid": int(attempt.process.pid or 0),
                "alive": bool(attempt.process.is_alive()),
            }
        )

    def mutate(run: dict[str, Any]) -> None:
        loop = run.setdefault("loop", {})
        loop["concurrency"] = concurrency
        loop["workers"] = workers
        run["active_tasks"] = [item["task_id"] for item in workers]
        if workers:
            latest = workers[-1]
            run["current_task"] = {
                "id": latest["task_id"],
                "status": latest["status"],
            }

    mutate_run(config.project.repo_root, loop_run_id, mutate)


def _record_worker_wave(
    config: AutoDevConfig,
    loop_run_id: str,
    wave: list[tuple[WorkerAttempt, ControllerResult]],
) -> None:
    def mutate(run: dict[str, Any]) -> None:
        history = run.setdefault("loop", {}).setdefault("worker_history", [])
        for attempt, result in wave:
            history.append(
                {
                    "worker_id": f"worker-{attempt.sequence:02d}",
                    "task_id": attempt.task_id,
                    "child_run_id": attempt.run_id,
                    "pid": int(attempt.process.pid or 0),
                    "exitcode": attempt.process.exitcode,
                    "status": result.status,
                }
            )

    mutate_run(config.project.repo_root, loop_run_id, mutate)


def _read_worker_result(
    config: AutoDevConfig,
    attempt: WorkerAttempt,
    adapter: QueuePort,
) -> ControllerResult:
    attempt.process.join(timeout=1)
    if attempt.result_path.exists():
        try:
            payload = json.loads(attempt.result_path.read_text(encoding="utf-8"))
            prompt = str(payload.get("prompt_path") or "")
            return ControllerResult(
                ok=bool(payload.get("ok")),
                status=str(payload.get("status") or "worker_process_error"),
                message=str(payload.get("message") or ""),
                run_id=str(payload.get("run_id") or attempt.run_id),
                task_id=str(payload.get("task_id") or attempt.task_id),
                prompt_path=Path(prompt) if prompt else None,
            )
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
            detail = f"invalid worker result: {exc}"
    else:
        detail = f"worker exited {attempt.process.exitcode} without a result artifact"

    # The result envelope is a convenience, not the only durable truth. A
    # worker can finish the reviewed candidate and then hit ENOSPC while
    # writing its envelope. Recover from the child run instead of blocking a
    # valid immutable candidate merely because that final copy failed.
    try:
        child = load_run(config.project.repo_root, attempt.run_id)
        current = child.get("current_task") or {}
        if (
            str(child.get("status") or "") == "candidate_ready"
            and str(current.get("id") or "") == attempt.task_id
        ):
            return ControllerResult(
                ok=True,
                status="candidate_ready",
                message="candidate recovered from child run after result artifact failure",
                run_id=attempt.run_id,
                task_id=attempt.task_id,
            )
    except Exception:
        pass

    status = "worker_process_crashed"
    message = detail
    try:
        task = adapter.get_task(attempt.task_id)
        if task.get("status") == "in_progress":
            blocked = adapter.block(
                attempt.task_id,
                reason=detail,
                next_action="检查 worker/host capacity 后人工恢复",
                expected_owner=str(task.get("owner") or ""),
                expected_lease_token=str(task.get("lease_token") or ""),
                expected_revision=int(task.get("revision")),
                failure_status=status,
                failure_run_id=attempt.run_id,
            )
            if not blocked.ok:
                status = "worker_needs_reconcile"
                message += f"; queue block failed: {blocked.status}: {blocked.message}"
    except Exception as exc:
        status = "worker_needs_reconcile"
        message += f"; queue state check failed: {type(exc).__name__}: {exc}"
    return ControllerResult(
        ok=False,
        status=status,
        message=message,
        run_id=attempt.run_id,
        task_id=attempt.task_id,
    )


def _cancel_candidate_result(
    config: AutoDevConfig,
    result: ControllerResult,
    *,
    reason: str,
) -> ControllerResult:
    try:
        child = load_run(config.project.repo_root, result.run_id)
        lease = _claim_from_child_run(child)
        port = _LeaseBoundQueuePort(create_queue_port(config), lease)
        released = port.release(result.task_id, note=reason)
    except Exception as exc:
        released = QueueOperationResult(
            ok=False, status="error", message=f"{type(exc).__name__}: {exc}"
        )
    status = "cancelled_by_breaker" if released.ok else "worker_needs_reconcile"
    message = reason
    if not released.ok:
        message += f"; queue release failed: {released.status}: {released.message}"
    _mark_run(
        config,
        result.run_id,
        status=status,
        task_id=result.task_id,
        task_status="pending" if released.ok else "needs_reconcile",
        message=message,
    )
    return ControllerResult(
        ok=False,
        status=status,
        message=message,
        run_id=result.run_id,
        task_id=result.task_id,
        prompt_path=result.prompt_path,
    )


def _worktree_dirty(path: str) -> bool:
    if not path:
        return False
    target = Path(path)
    if not target.exists():
        return False
    result = _git_at(target, "status", "--porcelain")
    return not result.ok or bool(result.stdout.strip())


def _worktree_evidence_diff(worktree: Path) -> str:
    """Capture both staged and unstaged changes (plus intent-to-add untracked).

    `git diff -- .` alone drops staged modifications, so a failed builder that
    ran `git add` would leave an incomplete evidence artifact. We surface the
    unstaged and staged diffs together.
    """
    untracked = _git_at(worktree, "ls-files", "--others", "--exclude-standard")
    if untracked.ok:
        paths = [line for line in untracked.stdout.splitlines() if line.strip()]
        if paths:
            # Intent-to-add so brand new files show up in the unstaged diff below.
            _run_command(["git", "add", "-N", "--", *paths], cwd=worktree, timeout_seconds=60)
    segments: list[str] = []
    unstaged = _git_at(worktree, "diff")
    unstaged_text = unstaged.stdout if unstaged.ok else unstaged.stderr
    if unstaged_text.strip():
        segments.append("# --- unstaged ---\n" + unstaged_text)
    staged = _git_at(worktree, "diff", "--cached")
    staged_text = staged.stdout if staged.ok else staged.stderr
    if staged_text.strip():
        segments.append("# --- staged ---\n" + staged_text)
    if not segments:
        return unstaged_text or staged_text
    return "\n".join(segments)


def _write_worktree_evidence(
    config: AutoDevConfig, outcome: LoopTaskOutcome, status_text: str
) -> tuple[Path, Path]:
    task_dir = _task_artifact_dir(config, outcome.run_id, outcome.task_id)
    status_path = task_dir / "failed_worktree_status.txt"
    diff_path = task_dir / "failed_worktree.diff"
    atomic_write_text(status_path, status_text)
    atomic_write_text(diff_path, _worktree_evidence_diff(Path(outcome.worktree_path)))
    return status_path, diff_path


def _archive_worktree_evidence_on_stop(
    config: AutoDevConfig, outcome: LoopTaskOutcome
) -> list[str]:
    """Archive (but do not reset) the failed worktree when the loop stops.

    On a terminal ``failed_worktree_dirty`` stop we keep the dirty worktree for
    human inspection, but must still persist diff/status so the stop conclusion
    has evidence to point at.
    """
    if not outcome.task_id or not outcome.worktree_path:
        return []
    worktree = Path(outcome.worktree_path)
    if not worktree.exists():
        return []
    status = _git_at(worktree, "status", "--porcelain")
    status_text = status.stdout if status.ok else (status.stderr or status.stdout or "git status failed")
    status_path, diff_path = _write_worktree_evidence(config, outcome, status_text)
    return [str(status_path), str(diff_path)]


def _blocking_findings(config: AutoDevConfig, outcome: LoopTaskOutcome) -> tuple[int, int]:
    if not outcome.task_id:
        return 0, 0
    review = run_paths(config.project.repo_root, outcome.run_id).tasks_dir / outcome.task_id / "review.yaml"
    if not review.exists():
        return 0, 0
    data = yaml.safe_load(review.read_text(encoding="utf-8")) or {}
    p0 = 0
    p1 = 0
    for finding in data.get("findings") or []:
        priority = str(finding.get("priority") or "")
        if priority == "P0":
            p0 += 1
        elif priority == "P1":
            p1 += 1
    return p0, p1


def _read_text_if_exists(path: Path, *, limit: int = 8000) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    if len(text) <= limit:
        return text
    return text[-limit:]


def _retry_context(config: AutoDevConfig, outcome: LoopTaskOutcome, *, next_attempt: int) -> tuple[str, list[str]]:
    if not outcome.task_id:
        return "", []
    task_dir = run_paths(config.project.repo_root, outcome.run_id).tasks_dir / outcome.task_id
    artifacts: list[str] = []
    lines = [
        f"这是第 {next_attempt} 次尝试，上一轮失败原因如下。",
        "请优先修复下列失败证据和 review findings，禁止推倒重写无关部分。",
    ]
    if outcome.worktree_path:
        lines.extend(
            [
                "",
                "## Workspace Boundary",
                f"- previous_worktree: `{outcome.worktree_path}`",
                "- The previous worktree is obsolete and evidence-only. Do not edit files or run commands there.",
                "- Work only under `repo_root` from Harness Run Context; all edits and verification must use the current worktree.",
            ]
        )
    lines.extend(["", "## Previous Builder Result"])

    builder_path = task_dir / "builder.json"
    if builder_path.exists():
        artifacts.append(str(builder_path))
        builder = json.loads(builder_path.read_text(encoding="utf-8"))
        marker_status, marker_message = _parse_builder_result(str(builder.get("stdout") or ""), str(builder.get("stderr") or ""))
        marker = f"{marker_status} | {marker_message}".strip(" |") if marker_status else "absent"
        lines.extend(
            [
                f"- artifact: `{builder_path}`",
                f"- returncode: `{builder.get('returncode')}`",
                f"- timed_out: `{builder.get('timed_out')}`",
                f"- AUTODEV_RESULT: {marker}",
            ]
        )
    else:
        lines.append("- builder.json not available")

    verify_summary_path = task_dir / "verify_summary.md"
    verify_path = task_dir / "verify.json"
    lines.extend(["", "## Previous Verify Evidence"])
    if verify_summary_path.exists():
        artifacts.append(str(verify_summary_path))
        lines.extend(["", "### verify_summary.md", "", "```markdown", _read_text_if_exists(verify_summary_path), "```"])
    elif verify_path.exists():
        artifacts.append(str(verify_path))
        verify = json.loads(verify_path.read_text(encoding="utf-8"))
        for item in verify.get("results") or []:
            if item.get("ok"):
                continue
            lines.extend(
                [
                    f"- command: `{item.get('command')}`",
                    f"- returncode: `{item.get('returncode')}`",
                    f"- timed_out: `{item.get('timed_out')}`",
                    "- stderr_tail:",
                    "```text",
                    str(item.get("stderr_tail") or ""),
                    "```",
                    "- stdout_tail:",
                    "```text",
                    str(item.get("stdout_tail") or ""),
                    "```",
                ]
            )
            break
    else:
        lines.append("- verify artifact not available")

    review_path = task_dir / "review.yaml"
    lines.extend(["", "## Previous Review Findings"])
    if review_path.exists():
        artifacts.append(str(review_path))
        review = yaml.safe_load(review_path.read_text(encoding="utf-8")) or {}
        findings = review.get("findings") or []
        if findings:
            for finding in findings:
                location = str(finding.get("file") or "")
                if finding.get("line"):
                    location = f"{location}:{finding.get('line')}"
                lines.extend(
                    [
                        f"- [{finding.get('priority')}] {location} {finding.get('title')}",
                        f"  impact: {finding.get('impact')}",
                        f"  recommendation: {finding.get('recommendation')}",
                    ]
                )
        else:
            lines.append("- no findings recorded")
        if review.get("message"):
            lines.append(f"- review_message: {review.get('message')}")
    else:
        lines.append("- review.yaml not available")
    diff_path = task_dir / "failed_worktree.diff"
    status_path = task_dir / "failed_worktree_status.txt"
    lines.extend(["", "## Previous Failed Worktree Diff"])
    if diff_path.exists():
        artifacts.append(str(diff_path))
        lines.append(f"- diff_artifact: `{diff_path}`")
        if status_path.exists():
            artifacts.append(str(status_path))
            lines.append(f"- status_artifact: `{status_path}`")
            lines.extend(["", "### git status", "", "```text", _read_text_if_exists(status_path, limit=4000), "```"])
        lines.extend(["", "### diff", "", "```diff", _read_text_if_exists(diff_path), "```"])
    else:
        lines.append("- failed worktree diff not available")
    return "\n".join(lines) + "\n", artifacts


def _record_loop_task(
    config: AutoDevConfig,
    loop_run_id: str,
    outcome: LoopTaskOutcome,
    *,
    final_blocked: bool,
    p0_delta: int = 0,
    p1_delta: int = 0,
    failure_class: str = "",
) -> None:
    def mutate(run: dict[str, Any]) -> None:
        loop = run.setdefault("loop", {})
        tasks = loop.setdefault("tasks", [])
        task_record = outcome.to_dict()
        # H-445: persist the retry classification so run.yaml keeps an audit trail of why
        # a failure was retried or blocked. Empty for successes.
        if failure_class:
            task_record["failure_class"] = failure_class
        tasks.append(task_record)
        current = {"id": outcome.task_id, "status": outcome.status, "commit": outcome.commit}
        if failure_class:
            current["failure_class"] = failure_class
        run["current_task"] = current
        summary = run.setdefault("summary", {})
        if outcome.ok:
            summary["tasks_done"] = int(summary.get("tasks_done") or 0) + 1
            summary["consecutive_failures"] = 0
        else:
            summary["consecutive_failures"] = int(summary.get("consecutive_failures") or 0) + 1
            if final_blocked:
                summary["tasks_blocked"] = int(summary.get("tasks_blocked") or 0) + 1
        findings = summary.setdefault("findings", {})
        findings["p0"] = int(findings.get("p0") or 0) + p0_delta
        findings["p1"] = int(findings.get("p1") or 0) + p1_delta

    mutate_run(config.project.repo_root, loop_run_id, mutate)


def _set_loop_status(config: AutoDevConfig, run_id: str, status: str, message: str) -> None:
    def mutate(run: dict[str, Any]) -> None:
        run["status"] = status
        run["next_action"] = message

    mutate_run(config.project.repo_root, run_id, mutate)


def _notify_safe(
    config: AutoDevConfig,
    run_id: str,
    *,
    event: str,
    status: str = "",
    message: str = "",
    task_id: str = "",
    artifact: str = "",
) -> None:
    try:
        dispatch_autodev_notification(
            config,
            run_id,
            event=event,
            status=status,
            message=message,
            task_id=task_id,
            artifact=artifact,
        )
    except Exception as exc:
        append_event(
            config.project.repo_root,
            run_id,
            level="warning",
            phase="notification_failed",
            task_id=task_id,
            message=f"{event}: {exc}",
            artifact=artifact,
        )


def _summary_markdown(
    *,
    run_id: str,
    status: str,
    message: str,
    outcomes: list[LoopTaskOutcome],
    direction_status: str,
    direction_review_path: Path | None,
) -> str:
    exceptions = [outcome for outcome in outcomes if not outcome.ok]
    done = [outcome for outcome in outcomes if outcome.ok]
    lines = [
        "# AutoDev Loop Summary",
        "",
        f"- run_id: `{run_id}`",
        f"- status: `{status}`",
        f"- stop_reason: `{message}`",
        f"- direction: `{direction_status}`",
    ]
    if direction_review_path:
        lines.append(f"- direction_review: `{direction_review_path}`")
    lines.extend(["", "## Exceptions"])
    if exceptions:
        for outcome in exceptions:
            lines.append(f"- `{outcome.task_id or '-'}` `{outcome.status}`: {outcome.message}")
    else:
        lines.append("- none")
    lines.extend(["", "## Needs Human Decision"])
    if status in {"blocking_findings", "failed_worktree_dirty", "consecutive_failures_stop"}:
        lines.append(f"- review `{run_id}` before resuming; stop_reason={message}")
    else:
        lines.append("- none")
    lines.extend(["", "## Done Tasks"])
    if done:
        for outcome in done:
            commit = f" commit `{outcome.commit}`" if outcome.commit else ""
            lines.append(f"- `{outcome.task_id}` via `{outcome.run_id}`{commit}")
    else:
        lines.append("- none")
    lines.extend(["", "## Candidate Memory", "- none"])
    return "\n".join(lines) + "\n"


def _write_loop_conclusions(
    config: AutoDevConfig,
    run_id: str,
    *,
    status: str,
    message: str,
    outcomes: list[LoopTaskOutcome],
) -> tuple[Path, Path]:
    paths = run_paths(config.project.repo_root, run_id)
    direction = write_direction_review_artifacts(
        config,
        run_id,
        outcomes,
        stop_reason=status,
        trigger="loop_end",
        checkpoint_done_count=sum(1 for outcome in outcomes if outcome.ok),
    )

    summary = _summary_markdown(
        run_id=run_id,
        status=status,
        message=message,
        outcomes=outcomes,
        direction_status=direction.status,
        direction_review_path=direction.output_markdown_path,
    )
    summary_run = paths.run_dir / "summary.md"
    atomic_write_text(summary_run, summary)
    summary_output = write_conclusion_artifact(config.project.repo_root, run_id, "summary.md", summary)
    append_event(
        config.project.repo_root,
        run_id,
        level="info",
        phase="summary",
        message="loop conclusion artifacts written",
        artifact=str(summary_output),
        extra={"direction_review": str(direction.output_markdown_path)},
    )
    return summary_output, direction.output_markdown_path


def _run_loop_impl(
    config: AutoDevConfig,
    *,
    max_tasks: int | None = None,
    max_minutes: int | None = None,
    run_id: str = "",
    queue_port: QueuePort | None = None,
    parallel: int | None = None,
) -> LoopResult:
    queue_port = queue_port or create_queue_port(config)
    run_id = run_id or _new_loop_run_id()
    effective_max_tasks = max_tasks or config.policy.max_tasks_per_loop
    effective_max_minutes = max_minutes or config.policy.max_minutes_per_loop
    if effective_max_tasks <= 0:
        raise ValueError("max_tasks must be positive")
    if effective_max_minutes <= 0:
        raise ValueError("max_minutes must be positive")
    if effective_max_tasks > config.policy.max_tasks_per_loop_after_direction_gate:
        raise ValueError(
            "max_tasks exceeds policy.max_tasks_per_loop_after_direction_gate"
        )

    create_run(
        config,
        run_id,
        initial={
            "status": "running",
            "budget": {"max_tasks": effective_max_tasks, "max_minutes": effective_max_minutes},
            "loop": {"tasks": []},
        },
    )
    append_event(
        config.project.repo_root,
        run_id,
        level="info",
        phase="loop_start",
        message="run-loop started",
        extra={"max_tasks": effective_max_tasks, "max_minutes": effective_max_minutes},
    )
    parallelism = parallel or config.execution.max_parallel_tasks
    if parallelism < 1 or parallelism > config.execution.max_parallel_tasks:
        raise ValueError(
            "parallel must be between 1 and execution.max_parallel_tasks"
        )
    try:
        host_policy = load_host_policy()
    except HostCapacityError as exc:
        _set_loop_status(config, run_id, "host_capacity_invalid", str(exc))
        return LoopResult(
            ok=False,
            status="host_capacity_invalid",
            message=str(exc),
            run_id=run_id,
            tasks_done=0,
            tasks_blocked=0,
        )
    if config.execution.max_parallel_tasks > 1:
        if host_policy is None:
            message = "parallel run-loop requires the XDG AutoDev host policy"
            _set_loop_status(config, run_id, "host_policy_required", message)
            return LoopResult(
                ok=False,
                status="host_policy_required",
                message=message,
                run_id=run_id,
                tasks_done=0,
                tasks_blocked=0,
            )
    # Validate notification config BEFORE the first notification dispatch: a real
    # webhook must never fire from an unvalidated config (invalid mode / provider
    # / missing env), so abort loudly here instead of at first send.
    notification_errors = validate_notifications_config(config)
    if notification_errors:
        message = "; ".join(notification_errors)
        append_event(
            config.project.repo_root,
            run_id,
            level="error",
            phase="preflight",
            message=f"notifications config invalid; loop aborted before any dispatch: {message}",
            extra={"notification_errors": notification_errors},
        )
        _set_loop_status(config, run_id, "notifications_config_invalid", message)
        return LoopResult(
            ok=False,
            status="notifications_config_invalid",
            message=message,
            run_id=run_id,
            tasks_done=0,
            tasks_blocked=0,
        )
    safety_errors = check_project_safety_policy(config)
    if safety_errors:
        message = "; ".join(safety_errors)
        append_event(
            config.project.repo_root,
            run_id,
            level="error",
            phase="preflight",
            message=f"project safety policy failed; loop aborted before any dispatch: {message}",
            extra={"safety_errors": safety_errors},
        )
        _set_loop_status(config, run_id, "safety_policy_red", message)
        return LoopResult(
            ok=False,
            status="safety_policy_red",
            message=message,
            run_id=run_id,
            tasks_done=0,
            tasks_blocked=0,
        )
    landing_errors = _reconcile_landing_ledgers(config)
    if not landing_errors:
        landing_errors = _reconcile_orphan_candidates(config)
    if landing_errors:
        message = "; ".join(landing_errors)
        append_event(
            config.project.repo_root,
            run_id,
            level="error",
            phase="landing_reconcile",
            message=message,
        )
        _set_loop_status(config, run_id, "landing_reconcile_required", message)
        return LoopResult(
            ok=False,
            status="landing_reconcile_required",
            message=message,
            run_id=run_id,
            tasks_done=0,
            tasks_blocked=0,
        )
    _notify_safe(
        config,
        run_id,
        event="loop_start",
        status="running",
        message=f"max_tasks={effective_max_tasks}, max_minutes={effective_max_minutes}",
    )
    if config.context_sharing.enabled:
        try:
            latest, output = write_loop_handoff(config, run_id)
            append_event(
                config.project.repo_root,
                run_id,
                level="info",
                phase="handoff",
                message="initial loop handoff packet written",
                artifact=str(output),
                extra={"latest": str(latest)},
            )
        except Exception as exc:
            append_event(
                config.project.repo_root,
                run_id,
                level="warning",
                phase="handoff",
                message=f"initial loop handoff packet failed: {exc}",
            )

    started = time.monotonic()
    outcomes: list[LoopTaskOutcome] = []
    tasks_done = 0
    tasks_blocked = 0
    consecutive_failures = 0
    task_failures: dict[str, int] = {}
    retry_contexts: dict[str, tuple[int, str, list[str], str]] = {}
    stop_reason = "max_tasks_reached"
    adapter = queue_port
    active: dict[str, WorkerAttempt] = {}
    completed: list[tuple[WorkerAttempt, ControllerResult]] = []
    worker_sequence = 0
    dispatch_stopped = False

    while (
        tasks_done + tasks_blocked < effective_max_tasks
        or bool(active)
        or bool(completed)
    ):
        if host_policy is not None and host_policy.global_stop_file.exists():
            if not dispatch_stopped:
                stop_reason = "global_stop_file"
                append_event(
                    config.project.repo_root,
                    run_id,
                    level="warning",
                    phase="stop",
                    message="global host STOP file present",
                )
            dispatch_stopped = True
            if parallelism == 1:
                break
        if _stop_file(config).exists():
            if not dispatch_stopped:
                stop_reason = "stop_file"
                append_event(config.project.repo_root, run_id, level="warning", phase="stop", message="STOP file present")
            dispatch_stopped = True
            if parallelism == 1:
                break
        if time.monotonic() - started >= effective_max_minutes * 60:
            if not dispatch_stopped:
                stop_reason = "time_budget_exhausted"
                append_event(config.project.repo_root, run_id, level="warning", phase="budget", message="time budget exhausted")
            dispatch_stopped = True
            if parallelism == 1:
                break
        if dispatch_stopped:
            for attempt in active.values():
                if attempt.cancel_event is not None:
                    attempt.cancel_event.set()

        if parallelism == 1:
            next_task = adapter.next()
            if not next_task.ok:
                stop_reason = next_task.status
                append_event(
                    config.project.repo_root,
                    run_id,
                    level="info",
                    phase="queue",
                    message=next_task.message or next_task.status,
                )
                break

            task_id_for_attempt = str((next_task.task or {}).get("id") or "")
            retry_attempt = 1
            retry_context_text = ""
            retry_artifacts: list[str] = []
            retry_from_run_id = ""
            if task_id_for_attempt in retry_contexts:
                (
                    retry_attempt,
                    retry_context_text,
                    retry_artifacts,
                    retry_from_run_id,
                ) = retry_contexts.pop(task_id_for_attempt)

            index = len(outcomes) + 1
            steer_text, steer_archive = _read_and_archive_steer(config, run_id, index)
            child_run_id = f"{run_id}-task-{index:02d}"
            result = run_one(
                config,
                run_id=child_run_id,
                steer_text=steer_text,
                retry_context=retry_context_text,
                retry_from_run_id=retry_from_run_id,
                queue_port=queue_port,
                supervisor_pid=os.getpid(),
            )
        else:
            if not active and not completed and not dispatch_stopped:
                remaining = effective_max_tasks - tasks_done - tasks_blocked
                queue_summary = adapter.summary()
                if not queue_summary.ok:
                    stop_reason = queue_summary.status
                    append_event(
                        config.project.repo_root,
                        run_id,
                        level="error",
                        phase="queue",
                        message=queue_summary.message or queue_summary.status,
                    )
                    break
                external_and_active = len(
                    list((queue_summary.summary or {}).get("in_progress") or [])
                )
                queue_slots = max(
                    0,
                    config.queue.max_in_progress - external_and_active,
                )
                dispatch_limit = min(parallelism, remaining, queue_slots)
                if dispatch_limit <= 0:
                    stop_reason = "queue_capacity_full"
                    append_event(
                        config.project.repo_root,
                        run_id,
                        level="info",
                        phase="queue",
                        message="queue in_progress capacity is currently full",
                    )
                    break
                candidates = adapter.ready_candidates(dispatch_limit)
                if not candidates:
                    stop_reason = "no_ready_task"
                    append_event(
                        config.project.repo_root,
                        run_id,
                        level="info",
                        phase="queue",
                        message="没有可领取的 pending 任务",
                    )
                    break
                for candidate in candidates:
                    task_id_for_attempt = str(candidate.get("id") or "")
                    if not task_id_for_attempt or task_id_for_attempt in active:
                        continue
                    retry_attempt_for_worker = 1
                    retry_context_for_worker = ""
                    retry_artifacts_for_worker: list[str] = []
                    retry_from_run_id_for_worker = ""
                    if task_id_for_attempt in retry_contexts:
                        (
                            retry_attempt_for_worker,
                            retry_context_for_worker,
                            retry_artifacts_for_worker,
                            retry_from_run_id_for_worker,
                        ) = retry_contexts.pop(task_id_for_attempt)
                    worker_sequence += 1
                    steer_text_for_worker, steer_archive_for_worker = _read_and_archive_steer(
                        config, run_id, worker_sequence
                    )
                    child_run_id = f"{run_id}-task-{worker_sequence:02d}"
                    attempt = _spawn_worker_attempt(
                        config,
                        loop_run_id=run_id,
                        task_id=task_id_for_attempt,
                        child_run_id=child_run_id,
                        steer_text=steer_text_for_worker,
                        steer_archive=steer_archive_for_worker,
                        retry_context=retry_context_for_worker,
                        retry_from_run_id=retry_from_run_id_for_worker,
                        retry_attempt=retry_attempt_for_worker,
                        retry_artifacts=retry_artifacts_for_worker,
                        sequence=worker_sequence,
                    )
                    active[task_id_for_attempt] = attempt
                _update_parallel_workers(
                    config, run_id, active, concurrency=parallelism
                )

            if active:
                if any(attempt.process.is_alive() for attempt in active.values()):
                    _update_parallel_workers(
                        config, run_id, active, concurrency=parallelism
                    )
                    time.sleep(0.2)
                    continue
                wave: list[tuple[WorkerAttempt, ControllerResult]] = []
                for attempt in sorted(active.values(), key=lambda item: item.sequence):
                    wave.append((attempt, _read_worker_result(config, attempt, adapter)))
                _record_worker_wave(config, run_id, wave)
                active.clear()
                wave_has_blocker = any(
                    sum(_blocking_findings(config, _task_outcome(config, item))) > 0
                    for _, item in wave
                    if not item.ok
                )
                if wave_has_blocker:
                    wave = [
                        (
                            attempt,
                            _cancel_candidate_result(
                                config,
                                item,
                                reason="parallel wave cancelled before landing due to P0/P1 finding",
                            )
                            if item.status == "candidate_ready"
                            else item,
                        )
                        for attempt, item in wave
                    ]
                wave.sort(
                    key=lambda pair: (
                        2
                        if pair[1].status == "cancelled_by_breaker"
                        else 1
                        if pair[1].ok
                        else 0,
                        pair[0].sequence,
                    )
                )
                completed.extend(wave)
                _update_parallel_workers(
                    config, run_id, active, concurrency=parallelism
                )

            if not completed:
                if dispatch_stopped:
                    break
                continue
            attempt, result = completed.pop(0)
            retry_attempt = attempt.retry_attempt
            retry_artifacts = attempt.retry_artifacts
            steer_archive = attempt.steer_archive
            if result.status == "candidate_ready":
                if dispatch_stopped and config.execution.stop_behavior == "halt_before_landing":
                    result = _cancel_candidate_result(
                        config,
                        result,
                        reason="STOP halt_before_landing released candidate",
                    )
                else:
                    result = _land_candidate(config, result)
        outcome = _task_outcome(config, result)
        outcomes.append(outcome)
        stop_reason_before_outcome = stop_reason
        p0_delta, p1_delta = _blocking_findings(config, outcome)
        final_blocked = False
        should_stop = False
        retry_scheduled = False
        cleanup_artifacts: list[str] = []
        failure_class = ""
        if not outcome.ok:
            final_blocked = True
            # H-445 (docs/25 §7 G2): classify the failure so only environment/transient
            # failures spend a fresh-session retry; logic failures block immediately.
            retryable = classify_failure_retryable(outcome.status)
            failure_class = "retryable" if retryable else "non_retryable"
            append_event(
                config.project.repo_root,
                run_id,
                level="info",
                phase="failure_classification",
                task_id=outcome.task_id,
                message=f"{outcome.status} classified as {failure_class}",
                extra={"status": outcome.status, "retryable": retryable, "failure_class": failure_class},
            )
            if outcome.status in _NON_RETRYABLE_LOOP_STATUSES:
                # H-446: fail-loud terminal stop. The task was never claimed (stays
                # pending) and the fix is out-of-band (commit the queue to base_ref),
                # so do not schedule a retry, do not count it as a task block, and do
                # not let it bubble up as retry_resume_failed.
                final_blocked = False
                stop_reason = outcome.status
                should_stop = True
            elif not outcome.task_id:
                final_blocked = False
                stop_reason = outcome.status
                should_stop = True
            elif p0_delta or p1_delta:
                task_failures[outcome.task_id] = task_failures.get(outcome.task_id, 0) + 1
                stop_reason = "blocking_findings"
                should_stop = True
            elif _worktree_dirty(outcome.worktree_path):
                task_failures[outcome.task_id] = task_failures.get(outcome.task_id, 0) + 1
                cleanup_artifacts = _archive_worktree_evidence_on_stop(config, outcome)
                if (
                    retryable
                    and consecutive_failures + 1 < config.policy.consecutive_failures_before_stop
                ):
                    if task_failures[outcome.task_id] < config.policy.same_task_failures_before_block:
                        cleanup_note = (
                            "failed worktree diff archived; dirty worktree preserved; "
                            "retry will use a fresh run worktree"
                        )
                    else:
                        # Task hit its per-task failure budget and is already
                        # blocked in the queue by run_one. Keep the loop alive
                        # for the remaining tasks while preserving evidence.
                        cleanup_note = (
                            "failed worktree diff archived; dirty worktree preserved; "
                            "task stays blocked, loop continues with next task"
                        )
                    append_event(
                        config.project.repo_root,
                        run_id,
                        level="warning",
                        phase="retry_cleanup",
                        task_id=outcome.task_id,
                        message=cleanup_note,
                        extra={"artifacts": cleanup_artifacts},
                    )
                else:
                    stop_reason = "failed_worktree_dirty"
                    should_stop = True
                    append_event(
                        config.project.repo_root,
                        run_id,
                        level="error",
                        phase="stop_archive",
                        task_id=outcome.task_id,
                        message="failed worktree diff/status archived at stop (worktree preserved for review)",
                        extra={"artifacts": cleanup_artifacts, "stop_reason": stop_reason},
                    )
            elif consecutive_failures + 1 >= config.policy.consecutive_failures_before_stop:
                task_failures[outcome.task_id] = task_failures.get(outcome.task_id, 0) + 1
                stop_reason = "consecutive_failures_stop"
                should_stop = True
            elif not retryable:
                # H-445: logic failure on a clean worktree (builder self-reported blocker,
                # verify assertion failure, contract tamper, unknown nature). A fresh-session
                # retry cannot fix it, so block the task directly (run_one already blocked it
                # in the queue) without consuming the same_task_failures_before_block budget.
                # final_blocked stays True; do not increment task_failures and do not resume.
                append_event(
                    config.project.repo_root,
                    run_id,
                    level="warning",
                    phase="block_non_retryable",
                    task_id=outcome.task_id,
                    message=f"non-retryable {outcome.status} blocked without retry",
                    extra={"status": outcome.status, "failure_class": failure_class},
                )
            else:
                task_failures[outcome.task_id] = task_failures.get(outcome.task_id, 0) + 1
            if (
                retryable
                and outcome.task_id
                and not should_stop
                and task_failures.get(outcome.task_id, 0) < config.policy.same_task_failures_before_block
            ):
                retry_note = (
                    "AutoDev retry after "
                    f"{outcome.status} ({task_failures[outcome.task_id]}/"
                    f"{config.policy.same_task_failures_before_block})"
                )
                try:
                    retry_task = adapter.get_task(outcome.task_id)
                except Exception as exc:
                    resume = QueueOperationResult(
                        ok=False,
                        status="queue_error",
                        message=f"cannot read task before retry: {exc}",
                    )
                else:
                    if retry_task.get("status") == "pending":
                        # Pre-agent and launch failures may CAS-release their
                        # claim. They are already retryable; calling resume on
                        # pending would turn a safe release into a false
                        # retry_resume_failed terminal.
                        resume = QueueOperationResult(
                            ok=True,
                            status="already_pending",
                            message=retry_note,
                            task=retry_task,
                        )
                    else:
                        resume = adapter.resume(
                            outcome.task_id,
                            note=retry_note,
                        )
                if resume.ok:
                    final_blocked = False
                    retry_scheduled = True
                    next_attempt = task_failures[outcome.task_id] + 1
                    retry_context, injected_artifacts = _retry_context(config, outcome, next_attempt=next_attempt)
                    retry_contexts[outcome.task_id] = (
                        next_attempt,
                        retry_context,
                        injected_artifacts,
                        outcome.run_id,
                    )
                    append_event(
                        config.project.repo_root,
                        run_id,
                        level="warning",
                        phase="retry",
                        task_id=outcome.task_id,
                        message=(
                            f"retry scheduled after {outcome.status} "
                            f"({task_failures[outcome.task_id]}/"
                            f"{config.policy.same_task_failures_before_block})"
                        ),
                        extra={
                            "attempt": next_attempt,
                            "injected_artifacts": injected_artifacts,
                            "cleanup_artifacts": cleanup_artifacts,
                        },
                    )
                else:
                    stop_reason = "retry_resume_failed"
                    should_stop = True

        if not outcome.ok and final_blocked and not retry_scheduled and outcome.task_id:
            try:
                terminal_task = adapter.get_task(outcome.task_id)
            except Exception:
                terminal_task = {}
            if terminal_task.get("status") == "pending":
                # A pre-claim failure or a safely released launch failure is a
                # loop-level operational stop, not a terminal task block.
                final_blocked = False
                should_stop = True
                stop_reason = outcome.status
        if outcome.status == "cancelled_by_breaker" and dispatch_stopped:
            final_blocked = False
            should_stop = True
            stop_reason = stop_reason_before_outcome

        _record_loop_task(
            config,
            run_id,
            outcome,
            final_blocked=final_blocked,
            p0_delta=p0_delta,
            p1_delta=p1_delta,
            failure_class=failure_class,
        )
        append_event(
            config.project.repo_root,
            run_id,
            level="info" if outcome.ok else "error",
            phase="task",
            task_id=outcome.task_id,
            message=f"{outcome.status}: {outcome.message}",
            artifact=str(steer_archive or ""),
            extra={**outcome.to_dict(), "attempt": retry_attempt, "retry_artifacts": retry_artifacts},
        )
        if outcome.ok:
            _notify_safe(
                config,
                run_id,
                event="task_done",
                status=outcome.status,
                message=outcome.message,
                task_id=outcome.task_id,
            )
        elif final_blocked or should_stop:
            event = "red_review" if outcome.status in {"review_red", "review_blocked"} else "task_blocked"
            _notify_safe(
                config,
                run_id,
                event=event,
                status=outcome.status,
                message=outcome.message,
                task_id=outcome.task_id,
            )

        if outcome.ok:
            tasks_done += 1
            consecutive_failures = 0
            every_done_tasks = config.policy.direction_check.every_done_tasks
            direction_mode = config.policy.direction_check.mode
            if direction_mode == "every_k_done" and every_done_tasks and tasks_done % every_done_tasks == 0:
                direction = write_direction_review_artifacts(
                    config,
                    run_id,
                    outcomes,
                    stop_reason="checkpoint",
                    trigger="after_done",
                    checkpoint_done_count=tasks_done,
                )
                if direction.should_stop:
                    stop_reason = "direction_drift" if direction.status == "drift" else "direction_blocked"
                    append_event(
                        config.project.repo_root,
                        run_id,
                        level="error",
                        phase="circuit_breaker",
                        message=f"direction checkpoint stopped loop: {direction.status}",
                        artifact=str(direction.output_markdown_path),
                    )
                    if direction.status == "drift":
                        _notify_safe(
                            config,
                            run_id,
                            event="direction_drift",
                            status=direction.status,
                            message=direction.data.get("next_action", ""),
                            artifact=str(direction.output_markdown_path),
                        )
                    break
        else:
            if final_blocked:
                tasks_blocked += 1
            consecutive_failures += 1
            if should_stop:
                break
            if retry_scheduled:
                continue

    else:
        stop_reason = "max_tasks_reached"

    for _, pending_result in completed:
        if pending_result.status == "candidate_ready":
            _cancel_candidate_result(
                config,
                pending_result,
                reason=f"parallel candidate released because loop stopped: {stop_reason}",
            )
    if active:
        # Parallel dispatch is wave-based, so this is only reachable on an
        # unexpected supervisor exception path. Do not silently orphan live
        # children during a normal return.
        for attempt in active.values():
            attempt.process.join()
        active.clear()
        _update_parallel_workers(config, run_id, active, concurrency=parallelism)

    status = stop_reason
    ok = loop_status_succeeded(status, tasks_blocked=tasks_blocked)
    _set_loop_status(config, run_id, status, stop_reason)
    summary_path, direction_path = _write_loop_conclusions(
        config,
        run_id,
        status=status,
        message=stop_reason,
        outcomes=outcomes,
    )
    _notify_safe(
        config,
        run_id,
        event="loop_summary",
        status=status,
        message=stop_reason,
        artifact=str(summary_path),
    )
    if config.context_sharing.enabled:
        try:
            latest, output = write_loop_handoff(config, run_id)
            append_event(
                config.project.repo_root,
                run_id,
                level="info",
                phase="handoff",
                message="final loop handoff packet written",
                artifact=str(output),
                extra={"latest": str(latest)},
            )
        except Exception as exc:
            append_event(
                config.project.repo_root,
                run_id,
                level="warning",
                phase="handoff",
                message=f"final loop handoff packet failed: {exc}",
            )
    return LoopResult(
        ok=ok,
        status=status,
        message=stop_reason,
        run_id=run_id,
        tasks_done=tasks_done,
        tasks_blocked=tasks_blocked,
        summary_path=summary_path,
        direction_review_path=direction_path,
    )


def run_loop(
    config: AutoDevConfig,
    *,
    max_tasks: int | None = None,
    max_minutes: int | None = None,
    run_id: str = "",
    queue_port: QueuePort | None = None,
    parallel: int | None = None,
) -> LoopResult:
    """Run a loop under one non-blocking, project-scoped ownership lease."""
    run_id = validate_run_id(run_id or _new_loop_run_id())
    lease = ProjectLoopLease.try_acquire(config.project.repo_root, config.project.id, run_id)
    if lease is None:
        return LoopResult(
            ok=False,
            status="loop_already_running",
            message="another run-loop owns this project's runtime lease",
            run_id=run_id,
            tasks_done=0,
            tasks_blocked=0,
        )
    with lease:
        return _run_loop_impl(
            config,
            max_tasks=max_tasks,
            max_minutes=max_minutes,
            run_id=run_id,
            queue_port=queue_port,
            parallel=parallel,
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AutoDev controller")
    sub = parser.add_subparsers(dest="command", required=True)

    run_one_parser = sub.add_parser("run-one", help="Run one AutoDev task")
    run_one_parser.add_argument("--project", default="", help="Config path; defaults to AUTODEV_CONFIG, then .autodev/project.yaml found upward from cwd, then XDG")
    run_one_parser.add_argument("--task", default="", help="Task id; defaults to next ready task")
    run_one_parser.add_argument("--run-id", default="", help="Run id; defaults to timestamp")
    run_one_parser.add_argument(
        "--retry-from",
        default="",
        help="Failed standalone run id whose candidate patch and findings must be restored",
    )
    run_one_parser.add_argument("--dry-run", action="store_true", help="Generate prompt/run files without invoking builder")
    run_one_parser.add_argument("--json", action="store_true", help="Print machine-readable result")

    run_loop_parser = sub.add_parser("run-loop", help="Run an AutoDev task loop")
    run_loop_parser.add_argument("--project", default="", help="Config path; defaults to AUTODEV_CONFIG, then .autodev/project.yaml found upward from cwd, then XDG")
    run_loop_parser.add_argument("--run-id", default="", help="Loop run id; defaults to timestamp")
    run_loop_parser.add_argument("--max-tasks", type=int, default=0, help="Max final tasks for this loop")
    run_loop_parser.add_argument("--max-minutes", type=int, default=0, help="Max minutes for this loop")
    run_loop_parser.add_argument("--parallel", type=int, default=0, help="Worker count; must not exceed configured max_parallel_tasks")
    run_loop_parser.add_argument("--json", action="store_true", help="Print machine-readable result")

    schedule_parser = sub.add_parser(
        "schedule",
        help="Conditionally auto-trigger a run-loop (unattended/overnight)",
    )
    schedule_parser.add_argument("--project", default="", help="Config path; defaults to AUTODEV_CONFIG, then .autodev/project.yaml found upward from cwd, then XDG")
    schedule_parser.add_argument("--run-id", default="", help="Loop run id; defaults to timestamp")
    schedule_parser.add_argument("--max-tasks", type=int, default=0, help="Max final tasks for the loop")
    schedule_parser.add_argument("--max-minutes", type=int, default=0, help="Max minutes for the loop")
    schedule_parser.add_argument(
        "--window",
        default="",
        help="Allowed time window 'HH:MM-HH:MM' (overrides schedule.window; empty=always)",
    )
    schedule_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only print whether it would trigger and why; do not start a loop",
    )
    schedule_parser.add_argument(
        "--now",
        default="",
        help="ISO timestamp override for the trigger check (mainly for testing)",
    )
    schedule_parser.add_argument("--json", action="store_true", help="Print machine-readable result")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "run-one":
            config = load_autodev_config(args.project)
            result = run_one(
                config,
                task_id=args.task,
                dry_run=args.dry_run,
                run_id=args.run_id,
                retry_from_run_id=args.retry_from,
            )
            if args.json:
                print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2, sort_keys=True))
            else:
                print(f"run_id: {result.run_id}")
                print(f"task_id: {result.task_id or '-'}")
                print(f"status: {result.status}")
                print(f"message: {result.message}")
                if result.prompt_path:
                    print(f"prompt: {result.prompt_path}")
            return 0 if result.ok else 1
        if args.command == "run-loop":
            config = load_autodev_config(args.project)
            result = run_loop(
                config,
                run_id=args.run_id,
                max_tasks=args.max_tasks or None,
                max_minutes=args.max_minutes or None,
                parallel=args.parallel or None,
            )
            if args.json:
                print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2, sort_keys=True))
            else:
                print(f"run_id: {result.run_id}")
                print(f"status: {result.status}")
                print(f"message: {result.message}")
                print(f"tasks_done: {result.tasks_done}")
                print(f"tasks_blocked: {result.tasks_blocked}")
                if result.summary_path:
                    print(f"summary: {result.summary_path}")
                if result.direction_review_path:
                    print(f"direction_review: {result.direction_review_path}")
            return 0 if result.ok else 1
        if args.command == "schedule":
            from datetime import datetime as _datetime

            from autodev.scheduler import (  # local import: avoid import cycle
                TimeWindow,
                run_scheduled_trigger,
                schedule_result_exit_code,
                window_from_config,
            )

            config = load_autodev_config(args.project)
            window = TimeWindow.parse(args.window) if args.window else window_from_config(config)
            now = _datetime.fromisoformat(args.now) if args.now else _datetime.now()
            schedule_result = run_scheduled_trigger(
                config,
                now=now,
                window=window,
                dry_run=args.dry_run,
                max_tasks=args.max_tasks or None,
                max_minutes=args.max_minutes or None,
                run_id=args.run_id,
            )
            if args.json:
                print(json.dumps(schedule_result.to_dict(), ensure_ascii=False, indent=2, sort_keys=True))
            else:
                decision = schedule_result.decision
                print(f"should_trigger: {decision.should_trigger}")
                print(f"reason: {decision.reason}")
                print(f"detail: {decision.detail}")
                print(f"triggered: {schedule_result.triggered}")
                print(f"dry_run: {schedule_result.dry_run}")
                print(f"log: {schedule_result.log_path}")
                if schedule_result.loop_result:
                    print(f"loop_status: {schedule_result.loop_result.get('status')}")
                    print(f"loop_run_id: {schedule_result.loop_result.get('run_id')}")
            return schedule_result_exit_code(schedule_result)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
