"""Load and validate AutoDev harness project configuration."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from importlib.resources import files
import os
from pathlib import Path
from typing import Any, Mapping
import warnings

import yaml

from autodev._internal.schema import ensure_schema_v1


CONFIG_ENV = "AUTODEV_CONFIG"
XDG_CONFIG_HOME_ENV = "XDG_CONFIG_HOME"
PACKAGED_CONFIG_RESOURCE = "autodev.example.yaml"


class AutoDevConfigError(ValueError):
    """Raised when AutoDev configuration is missing or unsafe."""


@dataclass(frozen=True)
class ProjectConfig:
    id: str
    name: str
    repo_root: Path


@dataclass(frozen=True)
class QueueConfig:
    type: str
    path: Path
    max_in_progress: int


@dataclass(frozen=True)
class ExecutionConfig:
    max_parallel_tasks: int
    stop_behavior: str
    circuit_breaker: str


@dataclass(frozen=True)
class WorktreeSetupConfig:
    mode: str
    source: str
    target: str
    commands: list[str]


@dataclass(frozen=True)
class WorktreeConfig:
    enabled: bool
    scope: str
    root: Path
    setup: WorktreeSetupConfig


@dataclass(frozen=True)
class BranchConfig:
    enabled: bool
    prefix: str
    strategy: str
    name_template: str
    base_ref: str
    commit_per_task: bool
    push: bool
    worktree: WorktreeConfig


@dataclass(frozen=True)
class AgentCommandConfig:
    kind: str
    command: str
    args: list[str]
    timeout_minutes: int | None = None
    max_turns: int | None = None
    fresh_session_per_task: bool = False
    permission_mode: str = ""
    allowlist_profile: str = ""
    read_only: bool = False
    frequency: str = ""
    permissions: "AgentPermissionsConfig | None" = None


@dataclass(frozen=True)
class AgentPermissionsConfig:
    profile: str
    allow: list[str]
    deny: list[str]


@dataclass(frozen=True)
class AgentConfig:
    builder: AgentCommandConfig
    evaluator: AgentCommandConfig
    commands: dict[str, AgentCommandConfig]
    builder_name: str
    evaluator_name: str
    allow_same_agent: bool
    evaluator_by_builder: dict[str, str]


@dataclass(frozen=True)
class VerifyConfig:
    default: list[str]
    command_timeout_minutes: int


@dataclass(frozen=True)
class DirectionCheckConfig:
    mode: str
    every_done_tasks: int


@dataclass(frozen=True)
class GovernanceConfig:
    mode: str
    reference_docs: list[Path]


@dataclass(frozen=True)
class PolicyConfig:
    max_tasks_per_loop: int
    max_tasks_per_loop_after_direction_gate: int
    max_minutes_per_loop: int
    same_task_failures_before_block: int
    consecutive_failures_before_stop: int
    direction_check: DirectionCheckConfig
    stop_file: str
    steer_file: str
    forbid_real_external_write: bool
    require_fresh_evaluator: bool
    require_fresh_builder_session: bool
    builder_session_retry: str
    require_worktree_isolation: bool
    require_explicit_base_commit: bool
    main_worktree_dirty_policy: str


@dataclass(frozen=True)
class ContextSharingConfig:
    enabled: bool
    mode: str
    latest_handoff_path: str
    agents_pointer: str
    handoff_on: list[str]
    save_context: dict[str, Any]
    brain_memory: dict[str, Any]
    bridges: dict[str, Any]


@dataclass(frozen=True)
class NotificationsConfig:
    mode: str
    provider: str
    fallback_provider: str


@dataclass(frozen=True)
class SafetyConfig:
    declared: bool
    forbidden_paths: list[str]
    secret_patterns: list[str]
    external_write_policy: str


@dataclass(frozen=True)
class AutoDevConfig:
    schema_version: int
    project: ProjectConfig
    queue: QueueConfig
    execution: ExecutionConfig
    branch: BranchConfig
    agent: AgentConfig
    verify: VerifyConfig
    governance: GovernanceConfig
    policy: PolicyConfig
    context_sharing: ContextSharingConfig
    notifications: NotificationsConfig
    safety: SafetyConfig
    raw: dict[str, Any]


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _read_yaml(path: Path, *, required: bool = False) -> dict[str, Any]:
    if not path.exists():
        if required:
            raise FileNotFoundError(f"AutoDev config not found: {path}")
        return {}
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise AutoDevConfigError(f"AutoDev config must be a mapping: {path}")
    return data


def load_packaged_config_template() -> dict[str, Any]:
    """Read the built-in defaults through importlib.resources."""
    resource = files("autodev.resources").joinpath(PACKAGED_CONFIG_RESOURCE)
    data = yaml.safe_load(resource.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise AutoDevConfigError(
            f"packaged AutoDev config template must be a mapping: {PACKAGED_CONFIG_RESOURCE}"
        )
    return data


def xdg_config_home(env: Mapping[str, str] | None = None) -> Path:
    env_map = os.environ if env is None else env
    configured = str(env_map.get(XDG_CONFIG_HOME_ENV) or "").strip()
    if configured:
        return Path(os.path.expandvars(configured)).expanduser()
    home = str(env_map.get("HOME") or "").strip()
    return (Path(home).expanduser() if home else Path.home()) / ".config"


def default_config_path(env: Mapping[str, str] | None = None) -> Path:
    return xdg_config_home(env) / "autodev" / "project.yaml"


def discover_project_config(start: Path | None = None) -> Path | None:
    """Walk from ``start`` (default cwd) upward looking for .autodev/project.yaml.

    Lets `autodev` commands run inside a scaffolded repository without
    `--project`/AUTODEV_CONFIG (E-202 dogfood P3); explicit settings still win.
    """
    current = (start or Path.cwd()).resolve()
    for candidate in (current, *current.parents):
        config = candidate / ".autodev" / "project.yaml"
        if config.is_file():
            return config
    return None


def resolve_config_path(
    config_path: str | Path | None = None,
    *,
    env: Mapping[str, str] | None = None,
    cwd: Path | None = None,
) -> Path:
    env_map = os.environ if env is None else env
    if config_path:
        return expand_path(config_path).resolve(strict=False)
    env_config = str(env_map.get(CONFIG_ENV) or "").strip()
    if env_config:
        return Path(os.path.expandvars(env_config)).expanduser().resolve(strict=False)
    discovered = discover_project_config(cwd)
    if discovered is not None:
        return discovered.resolve(strict=False)
    return default_config_path(env_map).resolve(strict=False)


def expand_path(value: str | Path) -> Path:
    return Path(os.path.expandvars(str(value))).expanduser()


def _section(raw: dict[str, Any], key: str) -> dict[str, Any]:
    value = raw.get(key)
    if not isinstance(value, dict):
        raise AutoDevConfigError(f"{key} must be a mapping")
    return value


def _required_str(raw: dict[str, Any], key: str, label: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise AutoDevConfigError(f"{label} is required")
    return value.strip()


def _str_list(raw: dict[str, Any], key: str, label: str, *, required: bool = False) -> list[str]:
    value = raw.get(key)
    if value is None:
        if required:
            raise AutoDevConfigError(f"{label} must be a list")
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise AutoDevConfigError(f"{label} must be a list of strings")
    return list(value)


def _str_mapping(raw: dict[str, Any], key: str, label: str) -> dict[str, str]:
    value = raw.get(key) or {}
    if not isinstance(value, dict):
        raise AutoDevConfigError(f"{label} must be a mapping")
    parsed: dict[str, str] = {}
    for raw_key, raw_value in value.items():
        name = str(raw_key).strip()
        target = str(raw_value).strip() if isinstance(raw_value, str) else ""
        if not name or not target:
            raise AutoDevConfigError(f"{label} must map non-empty strings to command names")
        parsed[name] = target
    return parsed


def _positive_int(raw: dict[str, Any], key: str, label: str, default: int | None = None) -> int:
    value = raw.get(key, default)
    if isinstance(value, bool) or value is None:
        raise AutoDevConfigError(f"{label} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise AutoDevConfigError(f"{label} must be a positive integer") from exc
    if parsed <= 0:
        raise AutoDevConfigError(f"{label} must be a positive integer")
    return parsed


def _optional_positive_int(raw: dict[str, Any], key: str, label: str) -> int | None:
    if key not in raw or raw.get(key) in (None, ""):
        return None
    return _positive_int(raw, key, label)


def _bool(raw: dict[str, Any], key: str, default: bool = False) -> bool:
    value = raw.get(key, default)
    if isinstance(value, bool):
        return value
    raise AutoDevConfigError(f"{key} must be a boolean")


def _resolve_repo_path(repo_root: Path, value: str | Path, label: str, *, must_exist: bool = False) -> Path:
    if not value:
        raise AutoDevConfigError(f"{label} is required")
    path = expand_path(value)
    if "$" in str(path):
        raise AutoDevConfigError(f"{label} contains unresolved environment variables")
    if not path.is_absolute():
        path = repo_root / path
    path = path.resolve(strict=False)
    if must_exist and not path.exists():
        raise AutoDevConfigError(f"{label} does not exist: {path}")
    return path


def _parse_project(raw: dict[str, Any]) -> ProjectConfig:
    project = _section(raw, "project")
    repo_root_raw = _required_str(project, "repo_root", "project.repo_root")
    repo_root = expand_path(repo_root_raw)
    if "$" in str(repo_root):
        raise AutoDevConfigError("project.repo_root contains unresolved environment variables")
    repo_root = repo_root.resolve(strict=False)
    if not repo_root.exists():
        raise AutoDevConfigError(f"project.repo_root does not exist: {repo_root}")
    if not repo_root.is_dir():
        raise AutoDevConfigError(f"project.repo_root must be a directory: {repo_root}")
    return ProjectConfig(
        id=_required_str(project, "id", "project.id"),
        name=str(project.get("name") or project.get("id") or ""),
        repo_root=repo_root,
    )


def _parse_queue(raw: dict[str, Any], repo_root: Path) -> QueueConfig:
    queue = _section(raw, "queue")
    queue_path = _resolve_repo_path(
        repo_root,
        _required_str(queue, "path", "queue.path"),
        "queue.path",
        must_exist=True,
    )
    parsed = QueueConfig(
        type=_required_str(queue, "type", "queue.type"),
        path=queue_path,
        max_in_progress=_positive_int(queue, "max_in_progress", "queue.max_in_progress", 1),
    )
    if parsed.max_in_progress > 3:
        raise AutoDevConfigError("queue.max_in_progress must be between 1 and 3")
    return parsed


def _parse_execution(raw: dict[str, Any], queue: QueueConfig) -> ExecutionConfig:
    execution = raw.get("execution") or {}
    if not isinstance(execution, dict):
        raise AutoDevConfigError("execution must be a mapping")
    max_parallel_tasks = _positive_int(
        execution,
        "max_parallel_tasks",
        "execution.max_parallel_tasks",
        1,
    )
    if max_parallel_tasks > 3:
        raise AutoDevConfigError("execution.max_parallel_tasks must be between 1 and 3")
    if max_parallel_tasks > queue.max_in_progress:
        raise AutoDevConfigError(
            "execution.max_parallel_tasks must be <= queue.max_in_progress"
        )
    stop_behavior = str(execution.get("stop_behavior") or "drain").strip()
    if stop_behavior not in {"drain", "halt_before_landing"}:
        raise AutoDevConfigError(
            "execution.stop_behavior must be one of: drain, halt_before_landing"
        )
    circuit_breaker = str(
        execution.get("circuit_breaker") or "cancel_and_requeue"
    ).strip()
    if circuit_breaker != "cancel_and_requeue":
        raise AutoDevConfigError(
            "execution.circuit_breaker must be cancel_and_requeue"
        )
    return ExecutionConfig(
        max_parallel_tasks=max_parallel_tasks,
        stop_behavior=stop_behavior,
        circuit_breaker=circuit_breaker,
    )


def _validate_queue_capacity(queue: QueueConfig) -> None:
    try:
        payload = yaml.safe_load(queue.path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise AutoDevConfigError(f"cannot read queue capacity policy: {queue.path}") from exc
    if not isinstance(payload, dict):
        raise AutoDevConfigError("task queue must be a mapping")
    policy = payload.get("policy") or {}
    if not isinstance(policy, dict):
        raise AutoDevConfigError("task queue policy must be a mapping")
    raw_limit = policy.get("max_in_progress", 1)
    if isinstance(raw_limit, bool):
        raise AutoDevConfigError("task queue policy.max_in_progress must be an integer")
    try:
        queue_limit = int(raw_limit)
    except (TypeError, ValueError) as exc:
        raise AutoDevConfigError(
            "task queue policy.max_in_progress must be an integer"
        ) from exc
    if queue_limit != queue.max_in_progress:
        raise AutoDevConfigError(
            "queue.max_in_progress does not match task queue "
            f"policy.max_in_progress ({queue.max_in_progress} != {queue_limit})"
        )


def _parse_worktree(raw: dict[str, Any], repo_root: Path) -> WorktreeConfig:
    worktree = raw if isinstance(raw, dict) else {}
    setup_raw = worktree.get("setup") or {}
    if not isinstance(setup_raw, dict):
        raise AutoDevConfigError("branch.worktree.setup must be a mapping")
    setup = WorktreeSetupConfig(
        mode=str(setup_raw.get("mode") or "none"),
        source=str(setup_raw.get("source") or ""),
        target=str(setup_raw.get("target") or ""),
        commands=_str_list(setup_raw, "commands", "branch.worktree.setup.commands"),
    )
    return WorktreeConfig(
        enabled=_bool(worktree, "enabled", True),
        scope=str(worktree.get("scope") or "per_loop"),
        root=_resolve_repo_path(repo_root, worktree.get("root") or ".autodev-worktrees", "branch.worktree.root"),
        setup=setup,
    )


def _parse_branch(raw: dict[str, Any], repo_root: Path) -> BranchConfig:
    branch = _section(raw, "branch")
    worktree_raw = branch.get("worktree") or {}
    if not isinstance(worktree_raw, dict):
        raise AutoDevConfigError("branch.worktree must be a mapping")
    return BranchConfig(
        enabled=_bool(branch, "enabled", True),
        prefix=str(branch.get("prefix") or "autodev/"),
        strategy=str(branch.get("strategy") or "per_loop_integration"),
        name_template=str(branch.get("name_template") or "autodev/{project_id}/{date}"),
        base_ref=str(branch.get("base_ref") or "main"),
        commit_per_task=_bool(branch, "commit_per_task", True),
        push=_bool(branch, "push", False),
        worktree=_parse_worktree(worktree_raw, repo_root),
    )


def _parse_agent_command(raw: dict[str, Any], label: str, *, default_kind: str = "command") -> AgentCommandConfig:
    if not isinstance(raw, dict):
        raise AutoDevConfigError(f"{label} must be a mapping")
    kind = str(raw.get("kind") or default_kind)
    command = _required_str(raw, "command", f"{label}.command")
    args = _str_list(raw, "args", f"{label}.args")
    forbidden_flags = {
        "--permission-mode", "--allowedTools", "--disallowedTools", "--sandbox",
        "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
        "--dangerously-bypass-approvals-and-sandbox",
        # Alternate roots/config/plugin surfaces can widen filesystem or tool
        # access behind the typed AutoDev permission profile.
        "--add-dir", "--cd", "-C", "--config", "--settings", "--mcp-config",
        "--plugin-dir", "--approval-policy", "--ask-for-approval", "--full-auto", "--yolo",
    }
    present = sorted(
        {arg.split("=", 1)[0] for arg in args if arg.split("=", 1)[0] in forbidden_flags}
    )
    session_reuse_flags = {"--resume", "--continue", "--session-id"}
    if kind in {"claude", "codex"}:
        present.extend(
            arg.split("=", 1)[0]
            for arg in args
            if arg.split("=", 1)[0] in session_reuse_flags
            or (kind == "codex" and arg == "resume")
        )
        present = sorted(set(present))
    if present:
        raise AutoDevConfigError(
            f"{label}.args contains permission flags {present}; move permissions to {label}.permissions"
        )
    permissions_raw = raw.get("permissions")
    permission_mode = str(raw.get("permission_mode") or "").strip()
    legacy_profile = str(raw.get("allowlist_profile") or "").strip()
    if permission_mode == "allowlist":
        raise AutoDevConfigError(
            f"{label}.permission_mode=allowlist was never a valid CLI mode; migrate to {label}.permissions.profile"
        )
    if permission_mode and permission_mode != "plan":
        raise AutoDevConfigError(f"{label}.permission_mode is unsupported; use {label}.permissions")
    if permissions_raw is not None and (permission_mode or legacy_profile):
        raise AutoDevConfigError(f"{label} mixes legacy permission fields with permissions")
    if permissions_raw is None and (permission_mode == "plan" or legacy_profile):
        profile = legacy_profile or "autodev_checker"
        warnings.warn(
            f"{label} legacy permission fields are deprecated; use permissions.profile",
            DeprecationWarning,
            stacklevel=3,
        )
        permissions_raw = {"profile": profile, "allow": [], "deny": []}
    permissions = None
    if permissions_raw is not None:
        if not isinstance(permissions_raw, dict):
            raise AutoDevConfigError(f"{label}.permissions must be a mapping")
        profile = str(permissions_raw.get("profile") or "").strip()
        if profile not in {"autodev_builder", "autodev_checker", "custom"}:
            raise AutoDevConfigError(f"{label}.permissions.profile is invalid: {profile!r}")
        allow = _str_list(permissions_raw, "allow", f"{label}.permissions.allow")
        deny = _str_list(permissions_raw, "deny", f"{label}.permissions.deny")
        if profile == "custom" and not allow:
            raise AutoDevConfigError(f"{label}.permissions.allow must not be empty for custom profile")
        if profile == "autodev_checker" and allow:
            raise AutoDevConfigError(f"{label}.permissions.allow cannot widen autodev_checker")
        permissions = AgentPermissionsConfig(profile=profile, allow=allow, deny=deny)
    return AgentCommandConfig(
        kind=kind,
        command=command,
        args=args,
        timeout_minutes=_optional_positive_int(raw, "timeout_minutes", f"{label}.timeout_minutes"),
        max_turns=_optional_positive_int(raw, "max_turns", f"{label}.max_turns"),
        fresh_session_per_task=_bool(raw, "fresh_session_per_task", False),
        permission_mode=str(raw.get("permission_mode") or ""),
        allowlist_profile=str(raw.get("allowlist_profile") or ""),
        read_only=_bool(raw, "read_only", False),
        frequency=str(raw.get("frequency") or ""),
        permissions=permissions,
    )


def _parse_agent_commands(raw: dict[str, Any]) -> dict[str, AgentCommandConfig]:
    commands_raw = raw.get("commands") or {}
    if not isinstance(commands_raw, dict):
        raise AutoDevConfigError("agent.commands must be a mapping")
    commands: dict[str, AgentCommandConfig] = {}
    for name, value in commands_raw.items():
        command_name = str(name).strip()
        if not command_name:
            raise AutoDevConfigError("agent.commands contains an empty command name")
        commands[command_name] = _parse_agent_command(
            value or {},
            f"agent.commands.{command_name}",
            default_kind=command_name,
        )
    return commands


def _parse_agent_slot(
    agent: dict[str, Any],
    commands: dict[str, AgentCommandConfig],
    key: str,
) -> tuple[str, AgentCommandConfig]:
    value = agent.get(key)
    if isinstance(value, str):
        command_name = value.strip()
        if not command_name:
            raise AutoDevConfigError(f"agent.{key} must not be empty")
        if command_name not in commands:
            raise AutoDevConfigError(f"agent.{key} references undefined agent.commands.{command_name}")
        return command_name, commands[command_name]
    if isinstance(value, dict):
        return key, _parse_agent_command(value, f"agent.{key}")
    if value is None:
        raise AutoDevConfigError(f"agent.{key} is required")
    raise AutoDevConfigError(f"agent.{key} must be a mapping or command name")


def _parse_agent(raw: dict[str, Any]) -> AgentConfig:
    agent = _section(raw, "agent")
    commands = _parse_agent_commands(agent)
    builder_name, builder = _parse_agent_slot(agent, commands, "builder")
    evaluator_name, evaluator = _parse_agent_slot(agent, commands, "evaluator")
    if builder.permissions is None:
        raise AutoDevConfigError(f"agent.commands.{builder_name}.permissions is required for builder")
    if evaluator.permissions is None:
        raise AutoDevConfigError(f"agent.commands.{evaluator_name}.permissions is required for evaluator")
    if builder_name not in commands:
        commands[builder_name] = builder
    if evaluator_name not in commands:
        commands[evaluator_name] = evaluator
    evaluator_by_builder = _str_mapping(agent, "evaluator_by_builder", "agent.evaluator_by_builder")
    for target_name in evaluator_by_builder.values():
        if target_name not in commands:
            raise AutoDevConfigError(
                f"agent.evaluator_by_builder references undefined agent.commands.{target_name}"
            )
    return AgentConfig(
        builder=builder,
        evaluator=evaluator,
        commands=commands,
        builder_name=builder_name,
        evaluator_name=evaluator_name,
        allow_same_agent=_bool(agent, "allow_same_agent", False),
        evaluator_by_builder=evaluator_by_builder,
    )


def _parse_verify(raw: dict[str, Any]) -> VerifyConfig:
    verify = _section(raw, "verify")
    default_commands = _str_list(verify, "default", "verify.default", required=True)
    if not default_commands:
        raise AutoDevConfigError("verify.default must contain at least one command")
    return VerifyConfig(
        default=default_commands,
        command_timeout_minutes=_positive_int(
            verify,
            "command_timeout_minutes",
            "verify.command_timeout_minutes",
            10,
        ),
    )


def _parse_governance(raw: dict[str, Any], repo_root: Path) -> GovernanceConfig:
    governance = raw.get("governance") or {"mode": "generic"}
    if not isinstance(governance, dict):
        raise AutoDevConfigError("governance must be a mapping")
    mode = str(governance.get("mode") or "").strip()
    allowed_modes = {"generic", "project_docs", "disabled"}
    if mode not in allowed_modes:
        raise AutoDevConfigError(
            "governance.mode must be one of: " + ", ".join(sorted(allowed_modes))
        )
    reference_values = _str_list(
        governance,
        "reference_docs",
        "governance.reference_docs",
    )
    if mode == "project_docs" and not reference_values:
        raise AutoDevConfigError(
            "governance.reference_docs must contain at least one path when governance.mode=project_docs"
        )
    if mode != "project_docs" and reference_values:
        raise AutoDevConfigError(
            f"governance.reference_docs is only valid when governance.mode=project_docs, not {mode}"
        )
    reference_docs: list[Path] = []
    for index, value in enumerate(reference_values):
        path = _resolve_repo_path(
            repo_root,
            value,
            f"governance.reference_docs[{index}]",
            must_exist=True,
        )
        if not path.is_file():
            raise AutoDevConfigError(
                f"governance.reference_docs[{index}] must be a readable file: {path}"
            )
        try:
            path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise AutoDevConfigError(
                f"governance.reference_docs[{index}] must be a readable UTF-8 file: {path}"
            ) from exc
        reference_docs.append(path)
    return GovernanceConfig(mode=mode, reference_docs=reference_docs)


def _parse_policy(raw: dict[str, Any]) -> PolicyConfig:
    policy = _section(raw, "policy")
    direction_raw = policy.get("direction_check") or {}
    if not isinstance(direction_raw, dict):
        raise AutoDevConfigError("policy.direction_check must be a mapping")
    direction_mode = str(direction_raw.get("mode") or "every_k_done")
    allowed_direction_modes = {"every_k_done", "loop_end_only"}
    if direction_mode not in allowed_direction_modes:
        raise AutoDevConfigError(
            "policy.direction_check.mode must be one of: "
            + ", ".join(sorted(allowed_direction_modes))
        )
    builder_session_retry = str(
        policy.get("builder_session_retry") or "prefer_resume"
    ).strip()
    if builder_session_retry not in {"prefer_resume", "fresh"}:
        raise AutoDevConfigError(
            "policy.builder_session_retry must be one of: fresh, prefer_resume"
        )
    direction = DirectionCheckConfig(
        mode=direction_mode,
        every_done_tasks=_positive_int(direction_raw, "every_done_tasks", "policy.direction_check.every_done_tasks", 3),
    )
    return PolicyConfig(
        max_tasks_per_loop=_positive_int(policy, "max_tasks_per_loop", "policy.max_tasks_per_loop", 3),
        max_tasks_per_loop_after_direction_gate=_positive_int(
            policy,
            "max_tasks_per_loop_after_direction_gate",
            "policy.max_tasks_per_loop_after_direction_gate",
            6,
        ),
        max_minutes_per_loop=_positive_int(policy, "max_minutes_per_loop", "policy.max_minutes_per_loop", 240),
        same_task_failures_before_block=_positive_int(
            policy,
            "same_task_failures_before_block",
            "policy.same_task_failures_before_block",
            2,
        ),
        consecutive_failures_before_stop=_positive_int(
            policy,
            "consecutive_failures_before_stop",
            "policy.consecutive_failures_before_stop",
            3,
        ),
        direction_check=direction,
        stop_file=str(policy.get("stop_file") or ".autodev/STOP"),
        steer_file=str(policy.get("steer_file") or ".autodev/STEER.md"),
        forbid_real_external_write=_bool(policy, "forbid_real_external_write", True),
        require_fresh_evaluator=_bool(policy, "require_fresh_evaluator", True),
        require_fresh_builder_session=_bool(policy, "require_fresh_builder_session", True),
        builder_session_retry=builder_session_retry,
        require_worktree_isolation=_bool(policy, "require_worktree_isolation", True),
        require_explicit_base_commit=_bool(policy, "require_explicit_base_commit", True),
        main_worktree_dirty_policy=str(policy.get("main_worktree_dirty_policy") or "warn"),
    )


def _parse_context_sharing(raw: dict[str, Any]) -> ContextSharingConfig:
    context = _section(raw, "context_sharing")
    save_context = context.get("save_context") or {}
    brain_memory = context.get("brain_memory") or {}
    bridges = context.get("bridges") or {}
    for label, value in (
        ("context_sharing.save_context", save_context),
        ("context_sharing.brain_memory", brain_memory),
        ("context_sharing.bridges", bridges),
    ):
        if not isinstance(value, dict):
            raise AutoDevConfigError(f"{label} must be a mapping")
    return ContextSharingConfig(
        enabled=_bool(context, "enabled", True),
        mode=str(context.get("mode") or "packet_first"),
        latest_handoff_path=str(context.get("latest_handoff_path") or ".autodev/latest_handoff.md"),
        agents_pointer=str(context.get("agents_pointer") or "one_line_only"),
        handoff_on=_str_list(context, "handoff_on", "context_sharing.handoff_on"),
        save_context=save_context,
        brain_memory=brain_memory,
        bridges=bridges,
    )


def _parse_notifications(raw: dict[str, Any]) -> NotificationsConfig:
    notifications = _section(raw, "notifications")
    return NotificationsConfig(
        mode=str(notifications.get("mode") or "disabled"),
        provider=str(notifications.get("provider") or ""),
        fallback_provider=str(notifications.get("fallback_provider") or ""),
    )


def _parse_safety(raw: dict[str, Any]) -> SafetyConfig:
    declared = "safety" in raw
    safety = raw.get("safety") or {}
    if not isinstance(safety, dict):
        raise AutoDevConfigError("safety must be a mapping")
    external_write_policy = str(safety.get("external_write_policy") or "dry_run_only")
    allowed = {"dry_run_only", "notifications_only", "push_and_notifications"}
    if external_write_policy not in allowed:
        raise AutoDevConfigError(
            "safety.external_write_policy must be one of: dry_run_only, notifications_only, push_and_notifications"
        )
    return SafetyConfig(
        declared=declared,
        forbidden_paths=_str_list(safety, "forbidden_paths", "safety.forbidden_paths"),
        secret_patterns=_str_list(safety, "secret_patterns", "safety.secret_patterns"),
        external_write_policy=external_write_policy,
    )


def parse_autodev_config(raw: dict[str, Any]) -> AutoDevConfig:
    if not isinstance(raw, dict):
        raise AutoDevConfigError("AutoDev config must be a mapping")
    normalized = deepcopy(raw)
    schema_version = ensure_schema_v1(
        normalized,
        label="AutoDev config",
        error_type=AutoDevConfigError,
    )
    project = _parse_project(normalized)
    queue = _parse_queue(normalized, project.repo_root)
    execution = _parse_execution(normalized, queue)
    _validate_queue_capacity(queue)
    return AutoDevConfig(
        schema_version=schema_version,
        project=project,
        queue=queue,
        execution=execution,
        branch=_parse_branch(normalized, project.repo_root),
        agent=_parse_agent(normalized),
        verify=_parse_verify(normalized),
        governance=_parse_governance(normalized, project.repo_root),
        policy=_parse_policy(normalized),
        context_sharing=_parse_context_sharing(normalized),
        notifications=_parse_notifications(normalized),
        safety=_parse_safety(normalized),
        raw=normalized,
    )


def load_autodev_config(
    config_path: str | Path | None = None,
    *,
    merge_example: bool = True,
    env: Mapping[str, str] | None = None,
) -> AutoDevConfig:
    selected = resolve_config_path(config_path, env=env)
    if not selected.exists():
        raise FileNotFoundError(
            f"AutoDev config not found: {selected}; pass --project, set {CONFIG_ENV}, "
            f"or create {default_config_path(env)}"
        )
    raw = load_packaged_config_template() if merge_example else {}
    raw = _deep_merge(raw, _read_yaml(selected, required=True))
    return parse_autodev_config(raw)
