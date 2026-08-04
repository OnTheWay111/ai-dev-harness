"""CLI facade for the configured QueuePort."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shlex
import sys
from typing import Any

import yaml

from autodev.config import load_autodev_config
from autodev.queue_adapter import QueueOperationResult, create_queue_port
from autodev._internal.process import run_process_group


def _common_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--project", default="", help="Config path; defaults to AUTODEV_CONFIG, then .autodev/project.yaml found upward from cwd, then XDG")
    parser.add_argument("--json", action="store_true", help="Print machine-readable result")
    return parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspect and mutate the configured AutoDev queue")
    sub = parser.add_subparsers(dest="command", required=True)
    common = _common_parser()

    sub.add_parser("summary", parents=[common], help="Show queue counts and next task")
    sub.add_parser("next", parents=[common], help="Show the next dependency-ready task")

    claim = sub.add_parser("claim", parents=[common], help="Claim the next or selected task")
    claim.add_argument("task_id", nargs="?", default="")
    claim.add_argument("--owner", default="autodev")
    claim.add_argument("--note", default="")

    done = sub.add_parser("done", parents=[common], help="Mark a task done")
    done.add_argument("task_id")
    done.add_argument("--note", default="")
    done.add_argument("--artifact", action="append", default=[])
    done.add_argument("--skip-verify", action="store_true")
    done.add_argument("--allow-empty-verify", action="store_true")
    done.add_argument("--verify-timeout", type=int, default=900)

    block = sub.add_parser("block", parents=[common], help="Block a task")
    block.add_argument("task_id")
    block.add_argument("--reason", required=True)
    block.add_argument("--next-action", default="")

    resume = sub.add_parser("resume", parents=[common], help="Resume a blocked task")
    resume.add_argument("task_id")
    resume.add_argument("--note", default="")
    resume.add_argument(
        "--reset-failure-budget",
        action="store_true",
        help="Human-audited reset after the configured AutoDev retry budget is exhausted",
    )

    propose = sub.add_parser("propose", parents=[common], help="Add an unapproved proposed task")
    propose.add_argument("--title", required=True)
    propose.add_argument("--goal", required=True)
    propose.add_argument("--acceptance", action="append", required=True)
    propose.add_argument("--verify", action="append", required=True)
    propose.add_argument("--source-ref", action="append", required=True)
    propose.add_argument("--priority", default="P2", choices=["P0", "P1", "P2", "P3"])
    propose.add_argument("--area", default="")
    propose.add_argument("--proposed-by", default="autodev")
    propose.add_argument("--depends-on", action="append", default=[])

    approve = sub.add_parser("approve", parents=[common], help="Approve a proposed task")
    approve.add_argument("task_id")
    approve.add_argument("--approver", default="human")
    approve.add_argument("--note", default="")
    return parser


def _payload(result: QueueOperationResult) -> dict[str, Any]:
    return result.to_dict()


def _print_result(result: QueueOperationResult, *, as_json: bool) -> None:
    payload = _payload(result)
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(yaml.safe_dump(payload, allow_unicode=True, sort_keys=False).rstrip())


def _run_verify_commands(commands: list[str], *, cwd: Path, timeout: int) -> tuple[bool, str]:
    for command in [str(item).strip() for item in commands if str(item).strip()]:
        try:
            result = run_process_group(
                shlex.split(command),
                cwd=cwd,
                timeout_seconds=timeout,
            )
        except OSError as exc:
            return False, f"{command}: {exc}"
        if result.timed_out:
            return False, f"{command}: timed out after {timeout} seconds"
        if result.returncode != 0:
            tail = ((result.stderr or result.stdout) or "")[-2000:].strip()
            return False, f"{command}: exit {result.returncode}{': ' + tail if tail else ''}"
    return True, ""


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = load_autodev_config(args.project or None)
        port = create_queue_port(config)
        if args.command == "summary":
            result = port.summary()
        elif args.command == "next":
            result = port.next()
        elif args.command == "claim":
            result = port.claim(args.task_id, owner=args.owner, note=args.note)
        elif args.command == "done":
            task = port.get_task(args.task_id)
            verify_commands = list(task.get("verify") or [])
            note = args.note
            if args.skip_verify:
                if not note.strip():
                    raise ValueError("--skip-verify requires --note for an audit trail")
                note = f"{note} [verify skipped]"
            elif not verify_commands:
                if not args.allow_empty_verify:
                    raise ValueError(
                        f"task {args.task_id} has no verify commands; use --allow-empty-verify "
                        "or --skip-verify --note"
                    )
                note = f"{note} [no verify command]".strip()
            else:
                ok, error = _run_verify_commands(
                    verify_commands,
                    cwd=config.project.repo_root,
                    timeout=args.verify_timeout,
                )
                if not ok:
                    raise RuntimeError(f"verify failed; task was not marked done: {error}")
            result = port.done(
                args.task_id,
                note=f"{note} [manual queue CLI reconcile]".strip(),
                artifacts=args.artifact,
                force_reconcile=True,
            )
        elif args.command == "block":
            result = port.block(
                args.task_id,
                reason=args.reason,
                next_action=args.next_action,
                force_reconcile=True,
            )
        elif args.command == "resume":
            if args.reset_failure_budget and not args.note.strip():
                raise ValueError("--reset-failure-budget requires --note for an audit trail")
            result = port.resume(
                args.task_id,
                note=args.note,
                reset_failure_budget=args.reset_failure_budget,
            )
        elif args.command == "propose":
            result = port.propose(
                title=args.title,
                goal=args.goal,
                acceptance=args.acceptance,
                verify=args.verify,
                source_refs=args.source_ref,
                priority=args.priority,
                area=args.area,
                proposed_by=args.proposed_by,
                dependencies=args.depends_on,
            )
        elif args.command == "approve":
            result = port.approve(args.task_id, approver=args.approver, note=args.note)
        else:  # pragma: no cover - argparse requires a known command
            raise ValueError(f"unsupported queue command: {args.command}")
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    _print_result(result, as_json=args.json)
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
