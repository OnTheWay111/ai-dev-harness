"""AutoDev loop notification guardrails."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
from typing import Any, Callable
from urllib.error import HTTPError, URLError

from autodev.config import AutoDevConfig
from autodev.notification_adapters import DEFAULT_TITLE, PROVIDER_ADAPTERS, create_notification_adapter
from autodev.run_store import append_event
from autodev._internal.io import atomic_write_text


VALID_MODES = {"disabled", "dry_run", "real"}
VALID_PROVIDERS = set(PROVIDER_ADAPTERS)
INLINE_SECRET_FIELDS = {"webhook", "webhook_url", "url", "target", "token", "secret"}
ENV_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SENSITIVE_ENV_NAME_PATTERN = re.compile(
    r"(?i)(?:api[_-]?key|secret|token|password|webhook|cookie|credential|private[_-]?key)"
)
REDACTION_TOKEN = "[REDACTED]"


def send_webhook_notification(
    *,
    message: str,
    target: str,
    notification_config: dict[str, Any],
) -> dict[str, Any]:
    """Compatibility shim routing an old sender call through a provider adapter."""
    channel = str(notification_config.get("channel") or "webhook").lower()
    title = str(notification_config.get("title") or DEFAULT_TITLE)
    aliases = {"lark": "feishu", "ding_talk": "dingtalk"}
    adapter = create_notification_adapter(aliases.get(channel, channel))
    return adapter.send(
        message=message,
        target=target,
        title=title,
        timeout_seconds=float(notification_config.get("timeout_seconds") or 5),
    )


@dataclass(frozen=True)
class AutoDevNotificationResult:
    status: str
    mode: str
    event: str
    provider: str = ""
    path: Path | None = None
    reason: str = ""

    @property
    def ok(self) -> bool:
        return self.status in {"disabled", "dry_run", "sent"}

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "mode": self.mode,
            "event": self.event,
            "provider": self.provider,
            "path": str(self.path or ""),
            "reason": self.reason,
        }


def _notification_raw(config: AutoDevConfig) -> dict[str, Any]:
    raw = config.raw.get("notifications") or {}
    return raw if isinstance(raw, dict) else {}


def _mode(config: AutoDevConfig) -> str:
    mode = str(config.notifications.mode or "disabled").strip()
    if mode not in VALID_MODES:
        raise ValueError(f"invalid AutoDev notification mode: {mode}")
    return mode


def _providers(config: AutoDevConfig) -> list[str]:
    providers: list[str] = []
    for provider in (config.notifications.provider, config.notifications.fallback_provider):
        cleaned = str(provider or "").strip()
        if cleaned and cleaned not in providers:
            providers.append(cleaned)
    return providers or ["feishu"]


def _slug(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_")
    return cleaned or "notification"


def _dry_run_path(config: AutoDevConfig, run_id: str, event: str, task_id: str = "") -> Path:
    name = _slug(event if not task_id else f"{event}_{task_id}")
    return config.project.repo_root / "outputs" / "autodev" / run_id / "notifications" / f"{name}.md"


def build_autodev_notification_message(
    *,
    event: str,
    run_id: str,
    project_id: str,
    status: str = "",
    message: str = "",
    task_id: str = "",
    artifact: str = "",
) -> str:
    lines = [
        f"### {DEFAULT_TITLE}: {event}",
        "",
        f"- project: `{project_id}`",
        f"- run_id: `{run_id}`",
    ]
    if task_id:
        lines.append(f"- task_id: `{task_id}`")
    if status:
        lines.append(f"- status: `{status}`")
    if message:
        lines.append(f"- message: {message}")
    if artifact:
        lines.append(f"- artifact: `{artifact}`")
    return "\n".join(lines).rstrip() + "\n"


def _write_dry_run(
    config: AutoDevConfig,
    run_id: str,
    *,
    event: str,
    message: str,
    task_id: str = "",
) -> Path:
    path = _dry_run_path(config, run_id, event, task_id)
    atomic_write_text(path, message)
    return path


def _env_name_for_provider(raw: dict[str, Any], provider: str) -> str:
    key = f"{provider.lower()}_webhook_env"
    return str(raw.get(key) or "").strip()


def _inline_secret_fields(raw: dict[str, Any]) -> list[str]:
    return sorted(key for key in INLINE_SECRET_FIELDS if str(raw.get(key) or "").strip())


def _sensitive_env_values(
    raw: dict[str, Any],
    env_map: dict[str, str],
    providers: list[str],
) -> list[str]:
    """Return literal secret values that must never enter notification text.

    Provider webhook variables are sensitive even when their names are generic.
    Other environment values are considered only when the variable name clearly
    denotes a credential; short values are ignored to avoid redacting ordinary
    words or numbers throughout a message.
    """

    names = {
        _env_name_for_provider(raw, provider)
        for provider in providers
        if _env_name_for_provider(raw, provider)
    }
    names.update(name for name in env_map if SENSITIVE_ENV_NAME_PATTERN.search(name))
    values = {
        str(env_map.get(name) or "")
        for name in names
        if len(str(env_map.get(name) or "")) >= 8
    }
    return sorted(values, key=len, reverse=True)


def _redact_text(
    value: str,
    *,
    patterns: list[str],
    secret_values: list[str],
) -> tuple[str, bool, bool]:
    """Redact configured patterns and known secret literals from one field.

    The final boolean reports an invalid configured regex.  An invalid safety
    rule is itself unsafe: callers must not send real notifications and should
    suppress free-form text in local previews.
    """

    result = str(value or "")
    changed = False
    invalid_pattern = False
    for secret in secret_values:
        if secret and secret in result:
            result = result.replace(secret, REDACTION_TOKEN)
            changed = True
    for raw_pattern in patterns:
        try:
            result, count = re.subn(raw_pattern, REDACTION_TOKEN, result)
        except re.error:
            invalid_pattern = True
            continue
        changed = changed or bool(count)
    return result, changed, invalid_pattern


def _guard_notification_fields(
    config: AutoDevConfig,
    raw: dict[str, Any],
    env_map: dict[str, str],
    fields: dict[str, str],
) -> tuple[dict[str, str], bool, bool]:
    providers = _providers(config)
    secret_values = _sensitive_env_values(raw, env_map, providers)
    patterns = list(config.safety.secret_patterns)
    guarded: dict[str, str] = {}
    redacted = False
    invalid_pattern = False
    for key, value in fields.items():
        guarded_value, field_redacted, field_invalid = _redact_text(
            value,
            patterns=patterns,
            secret_values=secret_values,
        )
        guarded[key] = guarded_value
        redacted = redacted or field_redacted
        invalid_pattern = invalid_pattern or field_invalid
    if invalid_pattern:
        # Free-form model/agent text cannot be proven safe when a configured
        # detector is invalid.  Keep structured identifiers, suppress the two
        # fields most likely to carry arbitrary content, and fail real delivery.
        for key in ("message", "artifact"):
            if guarded.get(key):
                guarded[key] = REDACTION_TOKEN
                redacted = True
    return guarded, redacted, invalid_pattern


def validate_notifications_config(
    config: AutoDevConfig, env: dict[str, str] | None = None
) -> list[str]:
    """Return readable errors for an unusable notifications config.

    Checked at preflight and at the very start of run-loop, before any real
    webhook can fire, so a bad mode / provider / missing env aborts loudly
    instead of dispatching (or crashing on) an unvalidated notification.
    """
    errors: list[str] = []
    mode = str(config.notifications.mode or "disabled").strip()
    if mode not in VALID_MODES:
        errors.append(
            f"notifications.mode invalid: {mode!r} (allowed: {sorted(VALID_MODES)})"
        )
        return errors

    raw = _notification_raw(config)
    providers = _providers(config)
    for provider in providers:
        if provider not in VALID_PROVIDERS:
            errors.append(
                f"notifications.provider unknown: {provider!r} (allowed: {sorted(VALID_PROVIDERS)})"
            )

    if mode != "real":
        return errors

    inline_fields = _inline_secret_fields(raw)
    if inline_fields:
        errors.append(
            "notifications.mode=real must use provider webhook env names, not inline webhook/token fields: "
            + ", ".join(inline_fields)
        )
    env_map = dict(os.environ if env is None else env)
    for provider in providers:
        if provider not in VALID_PROVIDERS:
            continue
        env_name = _env_name_for_provider(raw, provider)
        if not env_name:
            errors.append(
                f"notifications.mode=real requires {provider}_webhook_env for provider {provider}"
            )
        elif not ENV_NAME_PATTERN.fullmatch(env_name):
            errors.append(
                f"notifications.mode=real {provider}_webhook_env must name an environment variable"
            )
        elif not str(env_map.get(env_name) or "").strip():
            errors.append(
                f"notifications.mode=real env {env_name} is empty or unset"
            )
    return errors


def _failure_result(
    config: AutoDevConfig,
    run_id: str,
    *,
    event: str,
    provider: str,
    reason: str,
    message: str,
    task_id: str = "",
) -> AutoDevNotificationResult:
    path = _write_dry_run(config, run_id, event=event, message=message, task_id=task_id)
    append_event(
        config.project.repo_root,
        run_id,
        level="warning",
        phase="notification_failed",
        task_id=task_id,
        message=reason,
        artifact=str(path),
        extra={"event": event, "provider": provider},
    )
    return AutoDevNotificationResult(
        status="failed",
        mode="real",
        event=event,
        provider=provider,
        path=path,
        reason=reason,
    )


def dispatch_autodev_notification(
    config: AutoDevConfig,
    run_id: str,
    *,
    event: str,
    status: str = "",
    message: str = "",
    task_id: str = "",
    artifact: str = "",
    env: dict[str, str] | None = None,
    sender: Callable[..., Any] | None = None,
) -> AutoDevNotificationResult:
    mode = _mode(config)
    raw = _notification_raw(config)
    env_map = dict(os.environ if env is None else env)
    guarded, redacted, invalid_pattern = _guard_notification_fields(
        config,
        raw,
        env_map,
        {
            "event": event,
            "run_id": run_id,
            "project_id": config.project.id,
            "status": status,
            "message": message,
            "task_id": task_id,
            "artifact": artifact,
        },
    )
    built = build_autodev_notification_message(
        event=guarded["event"],
        run_id=guarded["run_id"],
        project_id=guarded["project_id"],
        status=guarded["status"],
        message=guarded["message"],
        task_id=guarded["task_id"],
        artifact=guarded["artifact"],
    )
    # Real webhooks receive only the structured lifecycle envelope. Arbitrary
    # builder/evaluator text stays in the local (redacted) preview even when no
    # configured detector recognizes it; this closes the egress path for a
    # secret read from an unexpected file or injected by a malicious diff.
    outbound_built = build_autodev_notification_message(
        event=guarded["event"],
        run_id=guarded["run_id"],
        project_id=guarded["project_id"],
        status=guarded["status"],
        message="",
        task_id=guarded["task_id"],
        artifact="",
    )
    if mode == "disabled":
        return AutoDevNotificationResult(status="disabled", mode="disabled", event=event)
    if mode == "dry_run":
        path = _write_dry_run(
            config,
            run_id,
            event=guarded["event"],
            message=built,
            task_id=guarded["task_id"],
        )
        append_event(
            config.project.repo_root,
            run_id,
            level="info",
            phase="notification",
            task_id=guarded["task_id"],
            message=f"notification dry_run: {guarded['event']}",
            artifact=str(path),
            extra={
                "event": guarded["event"],
                "provider": config.notifications.provider or "feishu",
                "redacted": redacted,
                "invalid_secret_pattern": invalid_pattern,
            },
        )
        return AutoDevNotificationResult(
            status="dry_run",
            mode="dry_run",
            event=event,
            provider=config.notifications.provider or "feishu",
            path=path,
        )

    if redacted or invalid_pattern:
        return _failure_result(
            config,
            run_id,
            event=guarded["event"],
            provider=config.notifications.provider or "feishu",
            reason="real notification blocked because sensitive or unvalidated content was detected",
            message=built,
            task_id=guarded["task_id"],
        )

    inline_fields = _inline_secret_fields(raw)
    if inline_fields:
        return _failure_result(
            config,
            run_id,
            event=guarded["event"],
            provider=config.notifications.provider or "feishu",
            reason="real notification config must use provider env names, not raw webhook/token fields: "
            + ", ".join(inline_fields),
            message=built,
            task_id=guarded["task_id"],
        )

    errors: list[str] = []
    for provider in _providers(config):
        try:
            adapter = create_notification_adapter(provider)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        env_name = _env_name_for_provider(raw, provider)
        target = str(env_map.get(env_name) or "") if env_name else ""
        if not target:
            errors.append(f"{provider}: missing webhook env {env_name or '(unset)'}")
            continue
        try:
            adapter.send(
                message=outbound_built,
                target=target,
                title=str(raw.get("title") or DEFAULT_TITLE),
                timeout_seconds=float(raw.get("timeout_seconds") or 5),
                sender=sender,
            )
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            safe_error, _, _ = _redact_text(
                str(exc),
                patterns=list(config.safety.secret_patterns),
                secret_values=_sensitive_env_values(raw, env_map, _providers(config)),
            )
            errors.append(f"{provider}: {safe_error}")
            continue
        append_event(
            config.project.repo_root,
            run_id,
            level="info",
            phase="notification",
            task_id=guarded["task_id"],
            message=f"notification sent: {guarded['event']}",
            extra={"event": guarded["event"], "provider": provider},
        )
        return AutoDevNotificationResult(status="sent", mode="real", event=event, provider=provider)

    return _failure_result(
        config,
        run_id,
        event=guarded["event"],
        provider=config.notifications.provider or "feishu",
        reason="; ".join(errors) or "real notification failed",
        message=built,
        task_id=guarded["task_id"],
    )
