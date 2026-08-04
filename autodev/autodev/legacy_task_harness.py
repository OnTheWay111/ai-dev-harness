"""Compatibility CLI for the retired ``src.runtime.task_harness`` entrypoint.

This module owns no queue state-machine logic. It translates the historical
command surface to the package queue adapter so consumer repositories can keep
their old invocation while migrating documentation and automation.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

from autodev.adapters.queue_yaml import (
    PRIORITY_ORDER,
    VALID_STATUSES,
    add_task,
    approve_task,
    block_task,
    claim_task,
    complete_task,
    get_task,
    load_queue,
    next_task,
    propose_task,
    queue_summary,
    resume_task,
    skip_task,
)
from autodev.queue_cli import _run_verify_commands


def _queue_path(raw: str) -> Path:
    return Path(raw).expanduser().resolve(strict=False) if raw else Path.cwd() / "tasks" / "agent_task_queue.yaml"


def _project_root_for_queue(queue_path: Path) -> Path:
    """Return the historical queue's canonical project working directory."""
    if queue_path.parent.name == "tasks":
        return queue_path.parent.parent.resolve(strict=False)
    return queue_path.parent.resolve(strict=False)


def _print_task(task: dict[str, Any]) -> None:
    print(f"{task['id']} [{task.get('priority', 'P2')}] {task.get('status', 'pending')} - {task.get('title', '')}")
    if task.get("goal"):
        print(f"goal: {task['goal']}")
    for field in ("acceptance", "verify"):
        if task.get(field):
            print(f"{field}:")
            for item in task[field]:
                print(f"- {item}")
    if task.get("status") == "proposed":
        print("approval: 未批准，不会自动开发")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Legacy batch task harness compatibility adapter")
    parser.add_argument("--queue", default="", help="Queue YAML path; defaults to tasks/agent_task_queue.yaml")
    sub = parser.add_subparsers(dest="command", required=True)

    listing = sub.add_parser("list")
    listing.add_argument("--status", default="", choices=["", *sorted(VALID_STATUSES)])
    listing.add_argument("--json", action="store_true")
    sub.add_parser("next")

    claim = sub.add_parser("claim")
    claim.add_argument("task_id", nargs="?", default="")
    claim.add_argument("--owner", default="codex")
    claim.add_argument("--note", default="")
    claim.add_argument("--resume", action="store_true")

    done = sub.add_parser("done")
    done.add_argument("task_id")
    done.add_argument("--note", default="")
    done.add_argument("--artifact", action="append", default=[])
    done.add_argument("--skip-verify", action="store_true")
    done.add_argument("--allow-empty-verify", action="store_true")
    done.add_argument("--verify-timeout", type=int, default=900)

    block = sub.add_parser("block")
    block.add_argument("task_id")
    block.add_argument("--reason", required=True)
    block.add_argument("--next-action", default="")

    resume = sub.add_parser("resume")
    resume.add_argument("task_id")
    resume.add_argument("--note", default="")
    resume.add_argument("--claim", action="store_true")
    resume.add_argument("--owner", default="codex")

    skip = sub.add_parser("skip")
    skip.add_argument("task_id")
    skip.add_argument("--reason", required=True)

    add = sub.add_parser("add")
    add.add_argument("--title", required=True)
    add.add_argument("--priority", default="P2", choices=sorted(PRIORITY_ORDER))
    add.add_argument("--area", default="")
    add.add_argument("--goal", default="")
    add.add_argument("--acceptance", action="append", default=[])
    add.add_argument("--verify", action="append", default=[])
    add.add_argument("--depends-on", action="append", default=[])

    propose = sub.add_parser("propose")
    propose.add_argument("--title", required=True)
    propose.add_argument("--priority", default="P2", choices=sorted(PRIORITY_ORDER))
    propose.add_argument("--area", default="")
    propose.add_argument("--goal", required=True)
    propose.add_argument("--acceptance", action="append", required=True)
    propose.add_argument("--verify", action="append", required=True)
    propose.add_argument("--source-ref", action="append", required=True)
    propose.add_argument("--proposed-by", default="agent")
    propose.add_argument("--depends-on", action="append", default=[])

    approve = sub.add_parser("approve")
    approve.add_argument("task_id")
    approve.add_argument("--approver", default="human")
    approve.add_argument("--note", default="")

    summary = sub.add_parser("summary")
    summary.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    queue_path = _queue_path(args.queue)
    try:
        if args.command == "list":
            tasks = load_queue(queue_path).get("tasks", [])
            if args.status:
                tasks = [task for task in tasks if task.get("status") == args.status]
            if args.json:
                print(json.dumps(tasks, ensure_ascii=False, indent=2))
            else:
                for task in tasks:
                    _print_task(task)
            return 0
        if args.command == "next":
            task = next_task(load_queue(queue_path))
            if not task:
                print("没有可领取的 pending 任务")
                return 1
            _print_task(task)
            return 0
        if args.command == "claim":
            task = claim_task(
                queue_path,
                task_id=args.task_id,
                owner=args.owner,
                note=args.note,
                resume_blocked=args.resume,
            )
            print(f"claimed {task['id']}: {task.get('title', '')}")
            return 0
        if args.command == "done":
            task = get_task(queue_path, args.task_id)
            commands = list(task.get("verify") or [])
            note = args.note
            if args.skip_verify:
                if not note.strip():
                    raise ValueError("--skip-verify 需要 --note 说明跳过原因（留痕）")
                note = f"{note} [verify skipped]"
            elif not commands:
                if not args.allow_empty_verify:
                    raise ValueError(
                        f"任务 {args.task_id} 没有 verify 命令；用 --allow-empty-verify 放行，"
                        "或 --skip-verify --note 留痕后再 done"
                    )
                note = f"{note} [no verify command]".strip()
            else:
                ok, error = _run_verify_commands(
                    commands,
                    cwd=_project_root_for_queue(queue_path),
                    timeout=args.verify_timeout,
                )
                if not ok:
                    raise RuntimeError(f"verify 未通过，未标记 {args.task_id} done: {error}")
            result = complete_task(
                queue_path,
                task_id=args.task_id,
                note=f"{note} [manual legacy CLI reconcile]".strip(),
                artifacts=args.artifact,
                force_reconcile=True,
            )
            print(f"done {result['id']}")
            return 0
        if args.command == "block":
            task = block_task(
                queue_path,
                task_id=args.task_id,
                reason=args.reason,
                next_action=args.next_action,
                force_reconcile=True,
            )
            print(f"blocked {task['id']}: {args.reason}")
            return 0
        if args.command == "resume":
            if args.claim:
                task = claim_task(
                    queue_path,
                    task_id=args.task_id,
                    owner=args.owner,
                    note=args.note or "resumed and claimed",
                    resume_blocked=True,
                )
                print(f"resumed and claimed {task['id']}")
            else:
                task = resume_task(queue_path, task_id=args.task_id, note=args.note)
                print(f"resumed {task['id']}")
            return 0
        if args.command == "skip":
            task = skip_task(queue_path, task_id=args.task_id, reason=args.reason)
            print(f"skipped {task['id']}")
            return 0
        if args.command == "add":
            task = add_task(
                queue_path,
                title=args.title,
                priority=args.priority,
                area=args.area,
                goal=args.goal,
                acceptance=args.acceptance,
                verify=args.verify,
                dependencies=args.depends_on,
            )
            print(f"added {task['id']}: {task['title']}")
            return 0
        if args.command == "propose":
            task = propose_task(
                queue_path,
                title=args.title,
                priority=args.priority,
                area=args.area,
                goal=args.goal,
                acceptance=args.acceptance,
                verify=args.verify,
                source_refs=args.source_ref,
                proposed_by=args.proposed_by,
                dependencies=args.depends_on,
            )
            print(f"proposed {task['id']}: {task['title']} (未批准，不会自动开发)")
            return 0
        if args.command == "approve":
            task = approve_task(queue_path, task_id=args.task_id, approver=args.approver, note=args.note)
            print(f"approved {task['id']}: pending")
            return 0
        if args.command == "summary":
            summary = queue_summary(load_queue(queue_path))
            if args.json:
                print(json.dumps(summary, ensure_ascii=False, indent=2))
            else:
                print(f"counts: {summary['counts']}")
                print(f"in_progress: {', '.join(summary['in_progress']) or '-'}")
                print(f"next: {summary['next'] or '-'}")
            return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 2  # pragma: no cover


if __name__ == "__main__":
    raise SystemExit(main())
