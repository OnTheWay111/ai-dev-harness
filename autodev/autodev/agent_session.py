"""Typed, provider-aware builder session affinity for same-task retries."""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any
from autodev.config import AgentCommandConfig


@dataclass(frozen=True)
class BuilderSessionCandidate:
    session_id: str = ""
    source_run_id: str = ""
    reason: str = ""

    @property
    def resumable(self) -> bool:
        return bool(self.session_id)


@dataclass(frozen=True)
class BuilderInvocation:
    argv: list[str]
    mode: str
    session_id: str = ""
    source_session_id: str = ""
    reason: str = ""


@dataclass(frozen=True)
class BuilderOutput:
    stdout: str
    raw_stdout: str
    session_id: str = ""


def _arg_present(args: list[str], name: str) -> bool:
    return any(item == name or item.startswith(f"{name}=") for item in args)


def session_capability(command: AgentCommandConfig, argv: list[str]) -> tuple[bool, str]:
    """Return whether AutoDev can safely control session persistence for this argv."""
    kind = str(command.kind or "").lower()
    if kind == "claude":
        # Claude stores print-mode sessions under a cwd-derived project slug.
        # AutoDev retries intentionally use a new per-run worktree, so a
        # previous session is not discoverable from the new cwd.
        return False, "claude sessions are cwd-scoped; per-run worktrees cannot resume"
    if kind == "codex":
        if _arg_present(argv, "--ephemeral"):
            return False, "codex session persistence is disabled"
        if len(argv) < 2 or argv[1] != "exec":
            return False, "codex builder argv is not an exec command"
        return True, ""
    return False, f"agent kind {command.kind or 'command'} has no typed session adapter"


def build_builder_invocation(
    command: AgentCommandConfig,
    base_argv: list[str],
    *,
    resume_session_id: str = "",
    fallback: bool = False,
) -> BuilderInvocation:
    """Build a fresh or resumed builder command without accepting config-supplied flags."""
    supported, reason = session_capability(command, base_argv)
    if not supported:
        return BuilderInvocation(
            argv=list(base_argv),
            mode="fresh_fallback" if fallback else "fresh",
            reason=reason,
        )

    argv = list(base_argv)
    if resume_session_id:
        tail: list[str] = []
        sandbox_mode = ""
        index = 2
        while index < len(argv):
            item = argv[index]
            if item == "--sandbox" and index + 1 < len(argv):
                sandbox_mode = argv[index + 1]
                index += 2
                continue
            if item.startswith("--sandbox="):
                sandbox_mode = item.split("=", 1)[1]
                index += 1
                continue
            tail.append(item)
            index += 1
        argv = [argv[0], "exec", "resume", resume_session_id, *tail]
        # ``codex exec resume`` does not expose ``--sandbox`` even though
        # ordinary ``codex exec`` does. Preserve the typed permission decision
        # through its supported config override instead of dropping the guard.
        if sandbox_mode:
            argv.extend(["-c", f'sandbox_mode="{sandbox_mode}"'])
    if "--json" not in argv:
        argv.append("--json")
    return BuilderInvocation(
        argv=argv,
        mode="resumed" if resume_session_id else ("fresh_fallback" if fallback else "fresh"),
        source_session_id=resume_session_id,
    )


def decode_builder_output(command: AgentCommandConfig, stdout: str) -> BuilderOutput:
    """Extract Codex's durable thread id and final agent message from JSONL output."""
    if str(command.kind or "").lower() != "codex":
        return BuilderOutput(stdout=stdout, raw_stdout=stdout)

    session_id = ""
    messages: list[str] = []
    for line in stdout.splitlines():
        try:
            payload = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        if str(payload.get("type") or "") == "thread.started":
            session_id = str(payload.get("thread_id") or "").strip() or session_id
        item = payload.get("item")
        if isinstance(item, dict) and str(item.get("type") or "") == "agent_message":
            text = str(item.get("text") or "")
            if text:
                messages.append(text)
    normalized = "\n".join(messages) if messages else stdout
    return BuilderOutput(
        stdout=normalized,
        raw_stdout=stdout,
        session_id=session_id,
    )


def retry_session_candidate(
    builder_log_path: Path,
    *,
    current_agent: dict[str, Any],
    source_run_id: str,
) -> BuilderSessionCandidate:
    """Return a previous healthy session only when its builder identity still matches."""
    if not builder_log_path.exists():
        return BuilderSessionCandidate(reason="previous builder session was not recorded")
    try:
        payload = json.loads(builder_log_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return BuilderSessionCandidate(reason="previous builder session metadata is unreadable")
    if not isinstance(payload, dict):
        return BuilderSessionCandidate(reason="previous builder session metadata is invalid")
    if payload.get("returncode") != 0 or bool(payload.get("timed_out")):
        return BuilderSessionCandidate(reason="previous builder process was not healthy")

    previous_agent = payload.get("agent") or {}
    identity_keys = ("name", "kind", "command", "args")
    if not isinstance(previous_agent, dict) or any(
        previous_agent.get(key) != current_agent.get(key) for key in identity_keys
    ):
        return BuilderSessionCandidate(reason="builder identity changed since the failed run")

    session = payload.get("session") or {}
    session_id = str(session.get("session_id") or "").strip() if isinstance(session, dict) else ""
    if not session_id:
        return BuilderSessionCandidate(reason="previous builder has no resumable session id")
    return BuilderSessionCandidate(
        session_id=session_id,
        source_run_id=source_run_id,
    )
