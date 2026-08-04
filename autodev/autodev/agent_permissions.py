"""Translate typed agent permissions into auditable final argv."""
from __future__ import annotations

from autodev.config import AgentCommandConfig, AutoDevConfigError


BUILDER_ALLOW = (
    "Edit", "Write", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
    "Bash(git show:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git restore:*)",
    "Bash(ls:*)", "Bash(mkdir:*)", "Bash(python -m unittest:*)", "Bash(python -m pytest:*)",
    "Bash(python3 -m unittest:*)", "Bash(python3 -m pytest:*)",
)
HARD_DENY = (
    "Bash(git push:*)", "Bash(sudo:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(ssh:*)",
    "Bash(scp:*)", "Bash(launchctl:*)", "Bash(crontab:*)", "Bash(brew:*)",
    "Bash(npm publish:*)", "Bash(pip install:*)", "Bash(pip3 install:*)", "Bash(rm -rf:*)",
    "Read(~/.secrets.env)", "Read(**/.env)", "Read(**/id_rsa*)", "Read(**/*.pem)",
    "WebFetch", "WebSearch", "Task",
)


def _unique(values: list[str] | tuple[str, ...]) -> list[str]:
    return list(dict.fromkeys(item.strip() for item in values if item.strip()))


def _verify_allows(commands: list[str]) -> list[str]:
    return [f"Bash({command.strip()}:*)" for command in commands if command.strip()]


def permission_sets(command: AgentCommandConfig, verify_commands: list[str]) -> tuple[list[str], list[str]]:
    permissions = command.permissions
    if permissions is None:
        raise AutoDevConfigError("agent permissions are required")
    deny = _unique([*HARD_DENY, *permissions.deny])
    if permissions.profile == "autodev_checker":
        return [], deny
    base_allow = list(BUILDER_ALLOW) if permissions.profile == "autodev_builder" else []
    allow = _unique([*base_allow, *_verify_allows(verify_commands), *permissions.allow])
    deny_set = set(deny)
    return [item for item in allow if item not in deny_set], deny


def build_agent_argv(
    command: AgentCommandConfig,
    *,
    role: str,
    verify_commands: list[str],
) -> list[str]:
    if role not in {"builder", "checker"}:
        raise AutoDevConfigError(f"unsupported agent role: {role}")
    permissions = command.permissions
    if permissions is None:
        raise AutoDevConfigError("agent permissions are required")
    if role == "builder" and (command.read_only or permissions.profile == "autodev_checker"):
        raise AutoDevConfigError("read-only/checker agent cannot be promoted to builder")
    if role == "checker" and permissions.profile != "autodev_checker":
        raise AutoDevConfigError("checker role requires permissions.profile=autodev_checker")
    argv = [command.command, *command.args]
    if command.max_turns and "--max-turns" not in command.args:
        argv.extend(["--max-turns", str(command.max_turns)])
    kind = command.kind.lower()
    if kind not in {"claude", "codex", "command"}:
        raise AutoDevConfigError(f"unsupported agent kind: {command.kind!r}")
    allow, deny = permission_sets(command, verify_commands)
    if kind == "claude":
        argv.extend(["--permission-mode", "plan" if role == "checker" else "acceptEdits"])
        if role != "checker":
            if not allow:
                raise AutoDevConfigError("Claude builder permissions resolve to an empty allow set")
            argv.extend(["--allowedTools", *allow])
        argv.extend(["--disallowedTools", *deny])
    elif kind == "codex":
        argv.extend(["--sandbox", "read-only" if role == "checker" else "workspace-write"])
    return argv
