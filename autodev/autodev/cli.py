"""Stable top-level command line for the AutoDev harness."""
from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
import sys

from autodev import __version__


COMMAND_HELP = {
    "init": "Scaffold a draft AutoDev project config",
    "run-one": "Run one AutoDev task",
    "run-loop": "Run an AutoDev task loop",
    "status": "Show latest or selected run status",
    "schedule": "Conditionally trigger a run-loop",
    "dashboard": "Render or serve the read-only dashboard",
    "doctor": "Validate config, queue, and safety prerequisites",
    "queue": "Inspect and mutate the configured task queue",
    "queue-import-server": "Serve the authenticated atomic Queue Import API",
    "registry": "Inspect or migrate the XDG project registry",
    "database": "Manage the optional PostgreSQL persistence schema",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="autodev",
        description="Local-first development harness for Git projects.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    for command, help_text in COMMAND_HELP.items():
        sub.add_parser(command, add_help=False, help=help_text)
    return parser


def _handler(command: str) -> tuple[Callable[[list[str] | None], int], bool]:
    if command in {"run-one", "run-loop", "schedule"}:
        from autodev.controller import main

        return main, True
    if command == "init":
        from autodev.init import main

        return main, False
    if command == "status":
        from autodev.run_store import main

        return main, True
    if command == "dashboard":
        from autodev.web import main

        return main, False
    if command == "doctor":
        from autodev.doctor import main

        return main, False
    if command == "queue":
        from autodev.queue_cli import main

        return main, False
    if command == "queue-import-server":
        from autodev.queue_import_http import main

        return main, False
    if command == "registry":
        from autodev.registry import main

        return main, False
    if command == "database":
        from autodev.database.cli import main

        return main, False
    raise KeyError(command)


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        build_parser().print_help()
        return 0
    command = args[0]
    if command in COMMAND_HELP:
        handler, include_command = _handler(command)
        delegated = args if include_command else args[1:]
        return handler(delegated)
    build_parser().parse_args(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
