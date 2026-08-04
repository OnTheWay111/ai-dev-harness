"""Scaffold draft AutoDev project configs for other repositories."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shlex
import sys
from typing import Any

import yaml

from autodev._internal.io import atomic_write_text
from autodev.config import load_autodev_config
from autodev.registry import ProjectRegistryEntry, upsert_project_registry


DEFAULT_OUTPUT = ".autodev/project.yaml"


def _project_id_from_repo(repo: Path) -> str:
    value = re.sub(r"[^a-zA-Z0-9_-]+", "-", repo.name.strip()).strip("-").lower()
    return value or "autodev-project"


def probe_verify_suggestions(repo: Path) -> list[str]:
    suggestions: list[str] = []
    if (repo / "tests").is_dir():
        suggestions.append(".venv/bin/python -m unittest discover -s tests")
    if any((repo / name).exists() for name in ("pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini")):
        suggestions.append(".venv/bin/python -m pytest")
    package_json = repo / "package.json"
    if package_json.exists():
        try:
            package = json.loads(package_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            package = {}
        scripts = package.get("scripts") if isinstance(package, dict) else {}
        if isinstance(scripts, dict) and "test" in scripts:
            suggestions.append("npm test")
        else:
            suggestions.append("npm run test")
    if (repo / "go.mod").exists():
        suggestions.append("go test ./...")
    if (repo / "Cargo.toml").exists():
        suggestions.append("cargo test")
    return list(dict.fromkeys(suggestions))


def build_project_draft(repo: Path, *, project_id: str = "", name: str = "") -> dict[str, Any]:
    resolved_repo = repo.resolve(strict=True)
    resolved_id = project_id or _project_id_from_repo(resolved_repo)
    suggestions = probe_verify_suggestions(resolved_repo)
    return {
        "schema_version": 1,
        "project": {
            "id": resolved_id,
            "name": name or resolved_repo.name,
            "repo_root": str(resolved_repo),
        },
        "queue": {
            "type": "task_harness_yaml",
            "path": "tasks/agent_task_queue.yaml",
            "max_in_progress": 1,
        },
        "execution": {
            "max_parallel_tasks": 1,
            "stop_behavior": "drain",
            "circuit_breaker": "cancel_and_requeue",
        },
        "branch": {
            "enabled": True,
            "prefix": "autodev/",
            "strategy": "per_loop_integration",
            "name_template": "autodev/{project_id}/{date}",
            "base_ref": "main",
            "commit_per_task": True,
            "push": False,
            "worktree": {
                "enabled": True,
                "scope": "per_task",
                "root": "../.autodev-worktrees",
                "setup": {"mode": "none", "source": "", "target": "", "commands": []},
            },
        },
        "agent": {
            "builder": "claude",
            "evaluator": "codex_check",
            "allow_same_agent": False,
            "evaluator_by_builder": {"claude": "codex_check", "codex": "claude_check"},
            "commands": {
                "claude": {
                    "kind": "claude",
                    "command": "claude",
                    "args": ["-p", "--model", "opus", "--effort", "high", "--max-turns", "100"],
                    "fresh_session_per_task": True,
                    "timeout_minutes": 30,
                    "permissions": {"profile": "autodev_builder", "allow": [], "deny": []},
                },
                "codex": {
                    "kind": "codex",
                    "command": "codex",
                    "args": ["exec", "--model", "gpt-5.6-terra", "-c", 'model_reasoning_effort="high"', "-"],
                    "fresh_session_per_task": True,
                    "timeout_minutes": 30,
                    "permissions": {"profile": "autodev_builder", "allow": [], "deny": []},
                },
                "codex_check": {
                    "kind": "codex",
                    "command": "codex",
                    "args": ["exec", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"', "-"],
                    "fresh_session_per_task": True,
                    "read_only": True,
                    "frequency": "every_task",
                    "permissions": {"profile": "autodev_checker", "allow": [], "deny": []},
                },
                "claude_check": {
                    "kind": "claude",
                    "command": "claude",
                    "args": ["-p", "--model", "claude-fable-5", "--effort", "high", "--fallback-model", "claude-opus-4-8"],
                    "fresh_session_per_task": True,
                    "read_only": True,
                    "frequency": "every_task",
                    "permissions": {"profile": "autodev_checker", "allow": [], "deny": []},
                },
            },
        },
        "verify": {
            "default": suggestions or ["git diff --check"],
            "command_timeout_minutes": 10,
        },
        "governance": {"mode": "generic", "reference_docs": []},
        "policy": {
            "max_tasks_per_loop": 3,
            "max_tasks_per_loop_after_direction_gate": 6,
            "max_minutes_per_loop": 240,
            "same_task_failures_before_block": 2,
            "consecutive_failures_before_stop": 3,
            "direction_check": {"mode": "every_k_done", "every_done_tasks": 3},
            "stop_file": ".autodev/STOP",
            "steer_file": ".autodev/STEER.md",
            "forbid_real_external_write": True,
            "require_fresh_evaluator": True,
            "require_fresh_builder_session": True,
            "builder_session_retry": "prefer_resume",
            "require_worktree_isolation": True,
            "require_explicit_base_commit": True,
            "main_worktree_dirty_policy": "warn",
        },
        "context_sharing": {
            "enabled": True,
            "mode": "packet_first",
            "latest_handoff_path": ".autodev/latest_handoff.md",
            "agents_pointer": "one_line_only",
            "handoff_on": ["loop_end", "task_blocked", "red_review", "tool_switch"],
            "save_context": {"enabled": False, "invocation": "manual_only"},
            "brain_memory": {"auto_write": False},
            "bridges": {"diagnostic_only": True},
        },
        "notifications": {
            "mode": "dry_run",
            "provider": "feishu",
            "fallback_provider": "dingtalk",
            "feishu_webhook_env": "AUTODEV_FEISHU_WEBHOOK",
            "dingtalk_webhook_env": "AUTODEV_DINGTALK_WEBHOOK",
        },
        "safety": {
            "forbidden_paths": [".env", ".env.*", "secrets/**", "credentials/**"],
            "secret_patterns": [
                "(?i)(api[_-]?key|secret|token|password)\\s*[:=]\\s*['\\\"]?[A-Za-z0-9_./+=-]{12,}",
            ],
            "external_write_policy": "dry_run_only",
        },
        "scaffold": {
            "status": "draft",
            "suggested_verify": suggestions,
            "notes": [
                "Review verify.default before running AutoDev.",
                "branch.push stays false and notifications stay dry_run until this project has explicit guardrails.",
            ],
        },
    }


def write_project_draft(
    repo: Path,
    *,
    output: str | Path = DEFAULT_OUTPUT,
    project_id: str = "",
    name: str = "",
    force: bool = False,
) -> Path:
    if not repo.exists() or not repo.is_dir():
        raise FileNotFoundError(f"repo does not exist or is not a directory: {repo}")
    draft = build_project_draft(repo, project_id=project_id, name=name)
    target = Path(output)
    if not target.is_absolute():
        target = repo / target
    if target.exists() and not force:
        raise FileExistsError(f"AutoDev project draft already exists: {target}")
    text = yaml.safe_dump(draft, allow_unicode=True, sort_keys=False)
    atomic_write_text(target, text)
    return target


def _scaffold_files(repo: Path, config_path: Path, draft: dict[str, Any]) -> dict[Path, str]:
    queue = {"schema_version": 1, "policy": {"max_in_progress": 1}, "tasks": []}
    governance = "# AutoDev Governance\n\n- Resolve P0/P1 findings before continuing.\n- Keep push and real notifications disabled until explicitly approved.\n"
    agents = "# AutoDev\n\nFor autonomous development, read `.autodev/project.yaml` and the configured queue before acting.\n"
    settings = json.dumps(
        {
            "permissions": {
                "allow": ["Edit", "Write", "Bash(git status:*)", "Bash(git diff:*)"],
                "deny": ["Bash(git push:*)", "Bash(sudo:*)", "Read(**/.env)"],
            }
        },
        ensure_ascii=False,
        indent=2,
    ) + "\n"
    gitignore = ".autodev/runs/\n.autodev/latest_handoff.md\n.autodev-worktrees/\noutputs/autodev/\n"
    queue_path = Path(str(draft["queue"]["path"]))
    if not queue_path.is_absolute():
        queue_path = repo / queue_path
    return {
        config_path: yaml.safe_dump(draft, allow_unicode=True, sort_keys=False),
        queue_path: yaml.safe_dump(queue, allow_unicode=True, sort_keys=False),
        repo / "docs/autodev-governance.md": governance,
        repo / "AGENTS.md": agents,
        repo / ".claude/settings.local.json.example": settings,
        repo / ".autodev/gitignore.suggested": gitignore,
    }


def scaffold_project(
    repo: Path,
    *,
    output: str | Path = DEFAULT_OUTPUT,
    project_id: str = "",
    name: str = "",
    force: bool = False,
) -> tuple[list[Path], list[Path], Path]:
    if not repo.exists() or not repo.is_dir():
        raise FileNotFoundError(f"repo does not exist or is not a directory: {repo}")
    draft = build_project_draft(repo, project_id=project_id, name=name)
    config_path = Path(output)
    if not config_path.is_absolute():
        config_path = repo / config_path
    created: list[Path] = []
    skipped: list[Path] = []
    for target, text in _scaffold_files(repo, config_path, draft).items():
        if target.exists() and not force:
            skipped.append(target)
            continue
        atomic_write_text(target, text)
        created.append(target)
    return created, skipped, config_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Scaffold a draft AutoDev project config")
    parser.add_argument("--repo", required=True, help="Repository root to scaffold")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Output path; defaults to .autodev/project.yaml")
    parser.add_argument("--project-id", default="", help="Override generated project id")
    parser.add_argument("--name", default="", help="Override project display name")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing draft")
    parser.add_argument("--register", action="store_true", help="Explicitly upsert this project into the XDG registry")
    parser.add_argument("--registry", default="", help="Registry override used only with --register")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        created, skipped, target = scaffold_project(
            Path(args.repo).expanduser(),
            output=args.output,
            project_id=args.project_id,
            name=args.name,
            force=args.force,
        )
        if args.register:
            registered_config = load_autodev_config(target, merge_example=False)
            project = registered_config.project
            upsert_project_registry(
                ProjectRegistryEntry(project.id, project.name, target.resolve(), True),
                args.registry or None,
            )
        print(f"config: {target}")
        print(f"created: {len(created)}")
        print(f"skipped: {len(skipped)}")
        if args.register:
            print("registered: yes")
        print(f"next: export AUTODEV_CONFIG={shlex.quote(str(target.resolve()))}  # optional when running inside this repo")
        print(
            "next: commit the scaffold and queue to branch.base_ref "
            "(or point base_ref at your working branch) before run-one/run-loop"
        )
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
