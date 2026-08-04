"""Resolve per-task AutoDev builder/evaluator agent commands."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from autodev.config import AgentCommandConfig, AutoDevConfig


class AgentSelectionError(ValueError):
    """Raised when a task requests an unavailable or unsafe agent pairing."""


@dataclass(frozen=True)
class AgentSelection:
    builder_name: str
    builder: AgentCommandConfig
    evaluator_name: str
    evaluator: AgentCommandConfig
    preferred_builder: str

    def to_event_dict(self) -> dict[str, Any]:
        return {
            "preferred_builder": self.preferred_builder,
            "builder": command_to_dict(self.builder_name, self.builder),
            "evaluator": command_to_dict(self.evaluator_name, self.evaluator),
        }


def command_to_dict(name: str, command: AgentCommandConfig) -> dict[str, Any]:
    return {
        "name": name,
        "kind": command.kind,
        "command": command.command,
        "args": list(command.args),
        "timeout_minutes": command.timeout_minutes,
        "max_turns": command.max_turns,
        "fresh_session_per_task": command.fresh_session_per_task,
        "permission_mode": command.permission_mode,
        "allowlist_profile": command.allowlist_profile,
        "read_only": command.read_only,
        "frequency": command.frequency,
    }


def _signature(command: AgentCommandConfig) -> tuple[str, tuple[str, ...]]:
    return (command.command, tuple(command.args))


def _agent_identity(command: AgentCommandConfig) -> tuple[str, Any]:
    kind = str(command.kind or "").strip()
    if kind and kind != "command":
        return ("kind", kind)
    return ("signature", _signature(command))


def _task_preferred_builder(task: dict[str, Any]) -> str:
    value = task.get("preferred_builder")
    if value is None:
        raw = task.get("raw") or {}
        if isinstance(raw, dict):
            value = raw.get("preferred_builder")
    return str(value or "").strip()


def _catalog(config: AutoDevConfig) -> dict[str, AgentCommandConfig]:
    catalog = dict(config.agent.commands)
    catalog[config.agent.builder_name] = config.agent.builder
    catalog[config.agent.evaluator_name] = config.agent.evaluator
    for command in (config.agent.builder, config.agent.evaluator):
        aliases = [command.kind, Path(command.command).name]
        for alias in aliases:
            alias = str(alias or "").strip()
            if alias and alias != "command" and alias not in catalog:
                catalog[alias] = command
    return catalog


def _default_name(config: AutoDevConfig, command: AgentCommandConfig, fallback: str) -> str:
    if fallback:
        return fallback
    if _signature(command) == _signature(config.agent.builder):
        return config.agent.builder_name
    if _signature(command) == _signature(config.agent.evaluator):
        return config.agent.evaluator_name
    for name, candidate in config.agent.commands.items():
        if _signature(command) == _signature(candidate):
            return name
    return fallback


def _mapped_evaluator(
    config: AutoDevConfig,
    *,
    builder_name: str,
    builder: AgentCommandConfig,
) -> tuple[str, AgentCommandConfig] | None:
    selectors = [builder_name, str(builder.kind or "").strip(), Path(builder.command).name]
    for selector in selectors:
        evaluator_name = config.agent.evaluator_by_builder.get(selector)
        if evaluator_name:
            return evaluator_name, config.agent.commands[evaluator_name]
    return None


def resolve_agent_selection(config: AutoDevConfig, task: dict[str, Any]) -> AgentSelection:
    preferred_builder = _task_preferred_builder(task)
    if preferred_builder:
        catalog = _catalog(config)
        builder = catalog.get(preferred_builder)
        if builder is None:
            raise AgentSelectionError(f"preferred_builder is not configured: {preferred_builder}")
        builder_name = preferred_builder
    else:
        builder = config.agent.builder
        builder_name = config.agent.builder_name

    builder_permissions = builder.permissions
    if (
        builder.read_only
        or builder_permissions is None
        or builder_permissions.profile == "autodev_checker"
    ):
        raise AgentSelectionError(
            f"preferred builder {builder_name!r} is configured as a read-only/checker agent"
        )

    mapped_evaluator = _mapped_evaluator(
        config,
        builder_name=builder_name,
        builder=builder,
    )
    if mapped_evaluator is not None:
        evaluator_name, evaluator = mapped_evaluator
    elif _signature(builder) == _signature(config.agent.evaluator):
        evaluator = config.agent.builder
        evaluator_name = config.agent.builder_name
    else:
        evaluator = config.agent.evaluator
        evaluator_name = config.agent.evaluator_name

    if config.policy.require_fresh_builder_session and not builder.fresh_session_per_task:
        raise AgentSelectionError(
            f"builder {builder_name!r} does not satisfy policy.require_fresh_builder_session"
        )
    if config.policy.require_fresh_evaluator and not evaluator.fresh_session_per_task:
        raise AgentSelectionError(
            f"evaluator {evaluator_name!r} does not satisfy policy.require_fresh_evaluator"
        )

    if _agent_identity(builder) == _agent_identity(evaluator) and not config.agent.allow_same_agent:
        raise AgentSelectionError(
            f"builder and evaluator resolve to the same agent command: {builder.command}"
        )

    return AgentSelection(
        builder_name=_default_name(config, builder, builder_name),
        builder=builder,
        evaluator_name=_default_name(config, evaluator, evaluator_name),
        evaluator=evaluator,
        preferred_builder=preferred_builder,
    )
