"""Verify gate and evidence artifacts for AutoDev."""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import shlex
import time
from typing import Any

from autodev.adapters import queue_yaml as task_harness
from autodev._internal.io import atomic_write_text
from autodev._internal.process import run_process_group


@dataclass(frozen=True)
class VerifyCommandEvidence:
    command: str
    returncode: int | None
    ok: bool
    duration_seconds: float
    timed_out: bool
    stdout_path: str
    stderr_path: str
    stdout_tail: str
    stderr_tail: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "command": self.command,
            "returncode": self.returncode,
            "ok": self.ok,
            "duration_seconds": self.duration_seconds,
            "timed_out": self.timed_out,
            "stdout_path": self.stdout_path,
            "stderr_path": self.stderr_path,
            "stdout_tail": self.stdout_tail,
            "stderr_tail": self.stderr_tail,
        }


@dataclass(frozen=True)
class VerifyGateResult:
    ok: bool
    status: str
    evidence_path: Path
    summary_path: Path | None
    results: list[VerifyCommandEvidence]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "evidence_path": str(self.evidence_path),
            "summary_path": str(self.summary_path or ""),
            "results": [item.to_dict() for item in self.results],
        }


def verify_commands_for_task(task: dict[str, Any], default_commands: list[str]) -> list[str]:
    commands = [str(command).strip() for command in task.get("verify") or [] if str(command).strip()]
    if commands:
        return commands
    return [str(command).strip() for command in default_commands if str(command).strip()]


def task_contract_drift(queue_path: str | Path, task_snapshot: dict[str, Any]) -> list[str]:
    task_id = str(task_snapshot.get("id") or "")
    if not task_id:
        return ["task id missing from claim snapshot"]
    try:
        current = task_harness.get_task(queue_path, task_id)
    except Exception as exc:
        return [f"task contract unreadable: {exc}"]

    reasons: list[str] = []
    for field in ("acceptance", "verify"):
        before = list(task_snapshot.get(field) or [])
        after = list(current.get(field) or [])
        if before != after:
            reasons.append(f"{field} changed")
    return reasons


def _write_streams(artifact_dir: Path, index: int, stdout: str, stderr: str) -> tuple[Path, Path]:
    stdout_path = artifact_dir / f"verify_{index:02d}.stdout.txt"
    stderr_path = artifact_dir / f"verify_{index:02d}.stderr.txt"
    atomic_write_text(stdout_path, stdout)
    atomic_write_text(stderr_path, stderr)
    return stdout_path, stderr_path


def _run_one(command: str, *, cwd: Path, timeout_seconds: int, artifact_dir: Path, index: int) -> VerifyCommandEvidence:
    started = time.monotonic()
    stdout = ""
    stderr = ""
    returncode: int | None = None
    timed_out = False
    try:
        proc = run_process_group(
            shlex.split(command),
            cwd=cwd,
            timeout_seconds=timeout_seconds,
        )
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        returncode = proc.returncode
        timed_out = proc.timed_out
        if timed_out and not stderr:
            stderr = f"command timed out after {timeout_seconds} seconds"
    except (FileNotFoundError, OSError) as exc:
        stderr = str(exc)
    duration = time.monotonic() - started
    stdout_path, stderr_path = _write_streams(artifact_dir, index, stdout, stderr)
    ok = returncode == 0 and not timed_out
    return VerifyCommandEvidence(
        command=command,
        returncode=returncode,
        ok=ok,
        duration_seconds=round(duration, 3),
        timed_out=timed_out,
        stdout_path=str(stdout_path),
        stderr_path=str(stderr_path),
        stdout_tail=stdout[-2000:],
        stderr_tail=stderr[-2000:],
    )


def _render_summary(results: list[VerifyCommandEvidence], status: str) -> str:
    lines = ["# Verify Summary", "", f"status: {status}", ""]
    if not results:
        lines.extend(["No verify commands were executed.", ""])
        return "\n".join(lines)
    for index, result in enumerate(results, start=1):
        verdict = "PASS" if result.ok else "FAIL"
        lines.extend(
            [
                f"## {index}. {verdict}",
                "",
                f"- command: `{result.command}`",
                f"- returncode: `{result.returncode}`",
                f"- duration_seconds: `{result.duration_seconds}`",
                f"- timed_out: `{result.timed_out}`",
                f"- stdout: `{result.stdout_path}`",
                f"- stderr: `{result.stderr_path}`",
                "",
            ]
        )
        if not result.ok and result.stderr_tail:
            lines.extend(["### stderr tail", "", "```text", result.stderr_tail, "```", ""])
    return "\n".join(lines)


def run_verify_gate(
    commands: list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    artifact_dir: Path,
) -> VerifyGateResult:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    cleaned = [str(command).strip() for command in commands if str(command).strip()]
    results: list[VerifyCommandEvidence] = []
    for index, command in enumerate(cleaned, start=1):
        result = _run_one(command, cwd=cwd, timeout_seconds=timeout_seconds, artifact_dir=artifact_dir, index=index)
        results.append(result)
        if not result.ok:
            break
    ok = bool(results) and all(item.ok for item in results)
    status = "passed" if ok else "failed"
    evidence_path = artifact_dir / "verify.json"
    evidence = {
        "ok": ok,
        "status": status,
        "results": [item.to_dict() for item in results],
    }
    atomic_write_text(evidence_path, json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    summary_path = None
    if not ok:
        summary_path = artifact_dir / "verify_summary.md"
        atomic_write_text(summary_path, _render_summary(results, status))
    return VerifyGateResult(
        ok=ok,
        status=status,
        evidence_path=evidence_path,
        summary_path=summary_path,
        results=results,
    )
