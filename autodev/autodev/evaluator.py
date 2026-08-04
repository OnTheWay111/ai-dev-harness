"""Fresh evaluator gate for AutoDev."""
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import re
import sys
from typing import Any

import yaml

from autodev._internal.io import atomic_write_text
from autodev._internal.time import now_iso
from autodev._internal.process import run_process_group


REVIEW_MARKER = "AUTODEV_REVIEW:"
BLOCKING_PRIORITIES = {"P0", "P1"}


@dataclass(frozen=True)
class ReviewFinding:
    priority: str
    file: str
    line: str
    title: str
    impact: str
    recommendation: str


@dataclass(frozen=True)
class EvaluatorReview:
    status: str
    message: str
    findings: list[ReviewFinding]
    acceptance_summary: list[str]
    tests_run: list[str]

    @property
    def should_block(self) -> bool:
        if self.status in {"red", "blocked"}:
            return True
        return any(finding.priority in BLOCKING_PRIORITIES for finding in self.findings)


@dataclass(frozen=True)
class EvaluatorGateResult:
    ok: bool
    status: str
    message: str
    should_block: bool
    review_md_path: Path
    review_yaml_path: Path
    prompt_path: Path
    raw_path: Path | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "message": self.message,
            "should_block": self.should_block,
            "review_md_path": str(self.review_md_path),
            "review_yaml_path": str(self.review_yaml_path),
            "prompt_path": str(self.prompt_path),
            "raw_path": str(self.raw_path or ""),
        }


@dataclass(frozen=True)
class _CommandResult:
    command: list[str]
    returncode: int | None
    stdout: str
    stderr: str
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out


def build_evaluator_prompt(
    task: dict[str, Any],
    *,
    run_id: str,
    builder_message: str,
    verify_evidence: dict[str, Any],
    diff_text: str = "",
) -> str:
    acceptance = "\n".join(f"- {item}" for item in task.get("acceptance") or [])
    tests = "\n".join(
        f"- {item.get('command')} => {'ok' if item.get('ok') else 'failed'}"
        for item in verify_evidence.get("results") or []
    )
    return "\n".join(
        [
            "你是 AutoDev fresh evaluator / steward gate。本轮只读审查，不允许修改文件。",
            "",
            "按 PM / Architect / QA / Ops / Memory 五个视角判断任务是否跑偏。",
            "输出必须包含一行结构化标记：",
            f"{REVIEW_MARKER} Green | <理由>",
            f"{REVIEW_MARKER} Yellow | <理由>",
            f"{REVIEW_MARKER} Red | <原因>",
            f"{REVIEW_MARKER} Blocked | <阻塞原因>",
            "请将实际标记作为独立纯文本行输出，不要包在 Markdown 反引号或代码块中。",
            "",
            "如有 finding，用 docs/21 对齐字段，至少写成：",
            "`[P1] path/to/file.py:123 title | impact: ... | recommendation: ...`",
            "",
            "P0/P1 或 Red/Blocked 会阻断当前任务 done。",
            "",
            "## Task",
            "",
            f"- run_id: {run_id}",
            f"- task_id: {task.get('id')}",
            f"- title: {task.get('title')}",
            f"- goal: {task.get('goal')}",
            "",
            "## Acceptance",
            "",
            acceptance or "- (none)",
            "",
            "## Builder Result",
            "",
            builder_message or "(none)",
            "",
            "## Verify Evidence",
            "",
            tests or "- (none)",
            "",
            "## Diff",
            "",
            "```diff",
            diff_text[-20000:] if diff_text else "(no diff supplied)",
            "```",
            "",
        ]
    )


def parse_evaluator_output(output: str, *, task: dict[str, Any], verify_evidence: dict[str, Any]) -> EvaluatorReview:
    status = "blocked"
    message = "review marker absent"
    for line in reversed(output.splitlines()):
        candidate = _normalize_marker_line(line)
        if candidate.startswith(REVIEW_MARKER):
            payload = candidate[len(REVIEW_MARKER) :].strip()
            verdict, _, details = payload.partition("|")
            status = verdict.strip().lower() or "yellow"
            message = details.strip()
            break
    if status not in {"green", "yellow", "red", "blocked"}:
        message = f"unknown review status {status}: {message}".strip()
        status = "blocked"

    findings = _parse_findings(output)
    acceptance_summary = [f"{item}: listed for review" for item in task.get("acceptance") or []]
    tests_run = [str(item.get("command") or "") for item in verify_evidence.get("results") or []]
    return EvaluatorReview(
        status=status,
        message=message,
        findings=findings,
        acceptance_summary=acceptance_summary,
        tests_run=[item for item in tests_run if item],
    )


def _normalize_marker_line(line: str) -> str:
    """Remove common whole-line Markdown wrappers without searching prose."""
    candidate = line.strip()
    while candidate.startswith(">"):
        candidate = candidate[1:].lstrip()
    wrappers = ("```", "**", "__", "`", "*", "_")
    changed = True
    while changed:
        changed = False
        for wrapper in wrappers:
            if (
                candidate.startswith(wrapper)
                and candidate.endswith(wrapper)
                and len(candidate) > len(wrapper) * 2
            ):
                candidate = candidate[len(wrapper) : -len(wrapper)].strip()
                changed = True
                break
    return candidate


def _parse_findings(output: str) -> list[ReviewFinding]:
    findings: list[ReviewFinding] = []
    seen: set[tuple[str, str, str, str, str, str]] = set()
    pattern = re.compile(
        r"^\[(P[0-3])\]\s+([^:\s]+)(?::(\d+))?\s*(.*?)(?:\s+\|\s+impact:\s*(.*?))?(?:\s+\|\s+recommendation:\s*(.*))?$"
    )
    for line in output.splitlines():
        match = pattern.match(_normalize_finding_line(line))
        if not match:
            continue
        priority, file_path, line_no, title, impact, recommendation = match.groups()
        finding = ReviewFinding(
            priority=priority,
            file=file_path,
            line=line_no or "",
            title=(title or "finding").strip(),
            impact=(impact or "needs steward review").strip(),
            recommendation=(recommendation or "fix before continuing").strip(),
        )
        key = (
            finding.priority,
            finding.file,
            finding.line,
            finding.title,
            finding.impact,
            finding.recommendation,
        )
        if key in seen:
            continue
        seen.add(key)
        findings.append(finding)
    return findings


def _normalize_finding_line(line: str) -> str:
    """Remove common Markdown presentation around a standalone finding.

    Evaluators naturally emit findings as list items, block quotes, bold text,
    or inline code even though the semantic payload still follows the required
    ``[P1] path:line ...`` contract. Normalize only whole-line decoration so a
    finding mentioned in ordinary prose is not accidentally promoted.
    """

    candidate = line.strip()
    while candidate.startswith(">"):
        candidate = candidate[1:].lstrip()
    candidate = re.sub(r"^(?:[-+*]|\d+[.)])\s+", "", candidate)
    wrappers = ("```", "**", "__", "`", "*", "_")
    changed = True
    while changed:
        changed = False
        for wrapper in wrappers:
            if (
                candidate.startswith(wrapper)
                and candidate.endswith(wrapper)
                and len(candidate) > len(wrapper) * 2
            ):
                candidate = candidate[len(wrapper) : -len(wrapper)].strip()
                changed = True
                break
    return candidate


def _run_command(command: list[str], *, cwd: Path, timeout_seconds: int, stdin: str) -> _CommandResult:
    try:
        proc = run_process_group(
            command,
            cwd=cwd,
            stdin=stdin,
            timeout_seconds=timeout_seconds,
        )
        return _CommandResult(
            command=command,
            returncode=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
            timed_out=proc.timed_out,
        )
    except (FileNotFoundError, OSError) as exc:
        return _CommandResult(command=command, returncode=None, stdout="", stderr=str(exc))


def _review_yaml(review: EvaluatorReview, *, task: dict[str, Any], run_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "generated_at": now_iso(),
        "status": review.status,
        "scope": {"type": "task", "refs": [run_id, str(task.get("id") or "")]},
        "findings": [asdict(finding) for finding in review.findings],
        "acceptance_summary": review.acceptance_summary,
        "tests_run": review.tests_run,
        "next_action": "block_current_task" if review.should_block else "continue",
        "message": review.message,
    }


def _review_md(review: EvaluatorReview, *, task: dict[str, Any]) -> str:
    lines = [f"治理结论：{review.status.capitalize()}", "", "Findings"]
    if review.findings:
        for finding in review.findings:
            loc = f"{finding.file}:{finding.line}" if finding.line else finding.file
            lines.append(f"- [{finding.priority}] {loc} {finding.title}")
    else:
        lines.append("- none")
    lines.extend(["", "Acceptance Check"])
    if review.acceptance_summary:
        for item in review.acceptance_summary:
            lines.append(f"- {item}")
    else:
        lines.append(f"- {task.get('id')}: no acceptance listed")
    lines.extend(["", "Test Coverage"])
    if review.tests_run:
        for command in review.tests_run:
            lines.append(f"- {command}")
    else:
        lines.append("- no tests recorded")
    lines.extend(["", "Next", f"- {review.message or review.status}"])
    return "\n".join(lines) + "\n"


def _write_review_artifacts(artifact_dir: Path, review: EvaluatorReview, *, task: dict[str, Any], run_id: str) -> tuple[Path, Path]:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    review_yaml_path = artifact_dir / "review.yaml"
    review_md_path = artifact_dir / "review.md"
    atomic_write_text(review_yaml_path, yaml.safe_dump(_review_yaml(review, task=task, run_id=run_id), allow_unicode=True, sort_keys=False))
    atomic_write_text(review_md_path, _review_md(review, task=task))
    return review_md_path, review_yaml_path


def _gate_message(review: EvaluatorReview) -> str:
    blocking = [finding for finding in review.findings if finding.priority in BLOCKING_PRIORITIES]
    if blocking:
        summary = "; ".join(f"{finding.priority} {finding.file}:{finding.line} {finding.title}" for finding in blocking)
        return f"{review.message}; blocking findings: {summary}"
    return review.message


def run_evaluator_gate(
    command: list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    artifact_dir: Path,
    task: dict[str, Any],
    run_id: str,
    builder_message: str,
    verify_evidence: dict[str, Any],
    diff_text: str = "",
    manual_review: bool = False,
) -> EvaluatorGateResult:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    prompt = build_evaluator_prompt(
        task,
        run_id=run_id,
        builder_message=builder_message,
        verify_evidence=verify_evidence,
        diff_text=diff_text,
    )
    prompt_path = artifact_dir / "review_prompt.md"
    atomic_write_text(prompt_path, prompt)

    if manual_review:
        review = EvaluatorReview(
            status="blocked",
            message="manual review package generated",
            findings=[],
            acceptance_summary=[f"{item}: pending manual review" for item in task.get("acceptance") or []],
            tests_run=[str(item.get("command") or "") for item in verify_evidence.get("results") or []],
        )
        review_md_path, review_yaml_path = _write_review_artifacts(artifact_dir, review, task=task, run_id=run_id)
        return EvaluatorGateResult(
            ok=True,
            status=review.status,
            message=_gate_message(review),
            should_block=True,
            review_md_path=review_md_path,
            review_yaml_path=review_yaml_path,
            prompt_path=prompt_path,
        )

    result = _run_command(command, cwd=cwd, timeout_seconds=timeout_seconds, stdin=prompt)
    raw_path = artifact_dir / "review_raw.json"
    atomic_write_text(
        raw_path,
        json.dumps(
            {
                "command": result.command,
                "returncode": result.returncode,
                "timed_out": result.timed_out,
                "stdout": result.stdout,
                "stderr": result.stderr,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    if result.timed_out:
        review = EvaluatorReview("blocked", "review timeout", [], [], [])
    elif not result.ok:
        review = EvaluatorReview("blocked", f"review exited with {result.returncode}", [], [], [])
    else:
        # Parse ONLY stdout. Codex CLI echoes the full prompt to stderr, and the
        # prompt necessarily contains marker/finding format examples; feeding
        # stderr into the parser turned those examples into fake blocking P1
        # findings, structurally blocking every codex-checker review even on a
        # real Green verdict (F1, 2026-07-11). stderr stays archived verbatim in
        # review_raw.json for forensics.
        review = parse_evaluator_output(result.stdout, task=task, verify_evidence=verify_evidence)
    review_md_path, review_yaml_path = _write_review_artifacts(artifact_dir, review, task=task, run_id=run_id)
    return EvaluatorGateResult(
        ok=result.ok and not review.should_block,
        status=review.status,
        message=_gate_message(review),
        should_block=review.should_block,
        review_md_path=review_md_path,
        review_yaml_path=review_yaml_path,
        prompt_path=prompt_path,
        raw_path=raw_path,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AutoDev evaluator utilities")
    sub = parser.add_subparsers(dest="command", required=True)

    review = sub.add_parser("review", help="Generate or run one evaluator review")
    review.add_argument("--artifact-dir", required=True)
    review.add_argument("--task-json", required=True)
    review.add_argument("--verify-json", required=True)
    review.add_argument("--run-id", default="manual")
    review.add_argument("--builder-message", default="")
    review.add_argument("--manual-review", action="store_true")
    review.add_argument("--agent-command", action="append", default=[])
    review.add_argument("--json", action="store_true")
    return parser


def _read_json(path: str | Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"JSON file must contain an object: {path}")
    return data


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "review":
            task = _read_json(args.task_json)
            verify = _read_json(args.verify_json)
            if not args.agent_command and not args.manual_review:
                raise ValueError("--agent-command is required unless --manual-review is set")
            command = args.agent_command
            result = run_evaluator_gate(
                command,
                cwd=Path.cwd(),
                timeout_seconds=600,
                artifact_dir=Path(args.artifact_dir),
                task=task,
                run_id=args.run_id,
                builder_message=args.builder_message,
                verify_evidence=verify,
                manual_review=args.manual_review,
            )
            if args.json:
                print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2, sort_keys=True))
            else:
                print(f"status: {result.status}")
                print(f"review: {result.review_md_path}")
            return 0 if result.ok or args.manual_review else 1
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
