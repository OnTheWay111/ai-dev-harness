"""Read-only installation and project configuration diagnostics."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from typing import Any

from autodev.config import load_autodev_config, resolve_config_path
from autodev.host_capacity import (
    HostCapacityError,
    create_host_capacity_broker,
    load_host_policy,
)
from autodev.notifications import validate_notifications_config
from autodev.queue_adapter import create_queue_port
from autodev.agent_permissions import HARD_DENY, build_agent_argv
from autodev.agent_probe import run_agent_probe


def _database_check() -> tuple[dict[str, Any], list[str]]:
    """Inspect optional persistence without importing SQLAlchemy in file mode."""
    from autodev.database.config import load_database_config

    config = load_database_config()
    if not config.uses_database:
        return {
            "ok": True,
            "active": False,
            "mode": config.mode,
            "safe_url": config.safe_url,
        }, []
    try:
        from autodev.database.engine import Database
        from autodev.database.health import check_database_health

        database = Database.from_config(config)
        try:
            report = check_database_health(database, config).to_dict()
        finally:
            database.dispose()
        report["active"] = True
        return report, ([] if report["ok"] else [f"database: {report['error']}"])
    except Exception as exc:
        return {
            "ok": False,
            "active": True,
            "mode": config.mode,
            "safe_url": config.safe_url,
            "error": f"{type(exc).__name__}: database check failed",
        }, [f"database: {type(exc).__name__}: database check failed"]


def _agent_cli_check(command: str, kind: str, *, execute: bool = False) -> dict[str, Any]:
    """Locate an agent command without executing repository-controlled argv.

    Normal ``doctor`` is a read-only diagnostic and therefore stops at
    ``shutil.which``.  An execution probe is available only to explicit callers
    (the public ``--probe-agent --yes`` path uses an isolated temporary repo).
    """
    executable = shutil.which(command)
    if not executable:
        return {"ok": False, "command": command, "error": "executable not found"}
    if not execute:
        return {
            "ok": True,
            "command": command,
            "path": executable,
            "skipped": True,
            "reason": "read-only doctor does not execute configured agent commands",
        }
    probe = [executable, "exec", "--help"] if kind == "codex" else [executable, "--help"]
    if kind not in {"codex", "claude"}:
        return {"ok": True, "command": command, "path": executable, "skipped": True}
    try:
        result = subprocess.run(probe, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "command": command, "path": executable, "error": str(exc)}
    error = (result.stderr or result.stdout or "")[-1000:] if result.returncode else ""
    return {"ok": result.returncode == 0, "command": command, "path": executable, "error": error}


def inspect_project(config_path: str = "") -> dict[str, Any]:
    selected = resolve_config_path(config_path or None)
    config = load_autodev_config(config_path or None)
    queue = create_queue_port(config).summary()
    errors = validate_notifications_config(config)
    if not queue.ok:
        errors.append(f"queue: {queue.status}: {queue.message}")
    warnings: list[str] = []
    database, database_errors = _database_check()
    errors.extend(database_errors)
    host_capacity: dict[str, Any] = {"controlled": False}
    try:
        host_policy = load_host_policy()
        if host_policy is None:
            if config.execution.max_parallel_tasks > 1:
                errors.append(
                    "execution.max_parallel_tasks > 1 requires the XDG AutoDev host policy"
                )
            else:
                warnings.append("global host capacity is not configured (uncontrolled compatibility mode)")
        else:
            host_capacity = create_host_capacity_broker(
                host_policy
            ).snapshot().to_dict()
            host_capacity["policy_path"] = str(host_policy.path)
    except HostCapacityError as exc:
        errors.append(f"host capacity: {exc}")
    agent_argv: dict[str, dict[str, list[str]]] = {}
    cli_checks: dict[str, dict[str, Any]] = {}
    for name, command in config.agent.commands.items():
        roles: list[str] = []
        if name == config.agent.builder_name or name in config.agent.evaluator_by_builder:
            roles.append("builder")
        if name == config.agent.evaluator_name or name in config.agent.evaluator_by_builder.values() or command.read_only:
            roles.append("checker")
        roles = roles or ["builder"]
        agent_argv[name] = {
            role: build_agent_argv(command, role=role, verify_commands=config.verify.default)
            for role in dict.fromkeys(roles)
        }
        permissions = command.permissions
        if permissions and permissions.profile == "custom":
            attempted = sorted(set(permissions.allow) & set(HARD_DENY))
            if attempted:
                warnings.append(
                    f"agent {name} custom allow attempts hard-denied rules (deny still wins): {attempted}"
                )
        cli_checks[name] = _agent_cli_check(command.command, command.kind, execute=False)
        if not cli_checks[name]["ok"]:
            errors.append(f"agent {name} CLI unavailable: {cli_checks[name]['error']}")
    if config.branch.push:
        warnings.append("branch.push is enabled")
    if config.notifications.mode == "real":
        warnings.append("notifications.mode is real")
    return {
        "ok": not errors,
        "config_path": str(selected),
        "project_id": config.project.id,
        "repo_root": str(config.project.repo_root),
        "queue_path": str(config.queue.path),
        "queue": queue.to_dict(),
        "errors": errors,
        "warnings": warnings,
        "agent_argv": agent_argv,
        "agent_cli": cli_checks,
        "host_capacity": host_capacity,
        "database": database,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate AutoDev config and local prerequisites")
    parser.add_argument("--project", default="", help="Config path; defaults to AUTODEV_CONFIG, then .autodev/project.yaml found upward from cwd, then XDG")
    parser.add_argument("--json", action="store_true", help="Print machine-readable diagnostics")
    parser.add_argument("--probe-agent", default="", help="Run a real, quota-consuming isolated probe for one agent command")
    parser.add_argument("--yes", action="store_true", help="Confirm --probe-agent model usage without prompting")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = inspect_project(args.project)
        if args.probe_agent:
            if not args.yes:
                print("This will call a real model and consume quota. Type yes to continue:", file=sys.stderr)
                if input().strip().lower() != "yes":
                    print("probe cancelled", file=sys.stderr)
                    return 1
            config = load_autodev_config(args.project or None)
            result["probe"] = run_agent_probe(config, args.probe_agent).to_dict()
            result["ok"] = result["ok"] and result["probe"]["ok"]
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"status: {'ok' if result['ok'] else 'failed'}")
        print(f"config: {result['config_path']}")
        print(f"project: {result['project_id']}")
        print(f"repo: {result['repo_root']}")
        print(f"queue: {result['queue_path']}")
        for warning in result["warnings"]:
            print(f"warning: {warning}")
        for error in result["errors"]:
            print(f"error: {error}")
        print(f"database: {result['database']}")
        for name, variants in result["agent_argv"].items():
            print(f"agent_argv[{name}]: {json.dumps(variants, ensure_ascii=False)}")
        if result.get("probe"):
            print(f"probe: {result['probe']}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
