"""Provider-owned webhook payloads and transport for AutoDev notifications."""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Callable, Protocol
from urllib.request import Request, urlopen


DEFAULT_TITLE = "AutoDev harness"
Sender = Callable[..., Any]


def _validate_target(target: str) -> None:
    if not target.startswith(("http://", "https://")):
        raise ValueError("real notification target must be an http(s) webhook URL")


def _post_json(target: str, payload: dict[str, Any], *, timeout_seconds: float) -> dict[str, Any]:
    _validate_target(target)
    request = Request(
        target,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "autodev-harness/0.1",
        },
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        return {"status_code": response.status}


class NotificationProviderAdapter(Protocol):
    name: str

    def build_payload(self, message: str, *, title: str = DEFAULT_TITLE) -> dict[str, Any]: ...

    def send(
        self,
        *,
        message: str,
        target: str,
        title: str = DEFAULT_TITLE,
        timeout_seconds: float = 5,
        sender: Sender | None = None,
    ) -> Any: ...


@dataclass(frozen=True)
class FeishuNotificationAdapter:
    name: str = "feishu"

    def build_payload(self, message: str, *, title: str = DEFAULT_TITLE) -> dict[str, Any]:
        del title
        return {"msg_type": "text", "content": {"text": message}}

    def send(
        self,
        *,
        message: str,
        target: str,
        title: str = DEFAULT_TITLE,
        timeout_seconds: float = 5,
        sender: Sender | None = None,
    ) -> Any:
        _validate_target(target)
        if sender:
            return sender(
                message=message,
                target=target,
                notification_config={
                    "channel": self.name,
                    "title": title,
                    "timeout_seconds": timeout_seconds,
                },
            )
        return _post_json(target, self.build_payload(message, title=title), timeout_seconds=timeout_seconds)


@dataclass(frozen=True)
class DingTalkNotificationAdapter:
    name: str = "dingtalk"

    def build_payload(self, message: str, *, title: str = DEFAULT_TITLE) -> dict[str, Any]:
        return {
            "msgtype": "markdown",
            "markdown": {"title": title, "text": message},
        }

    def send(
        self,
        *,
        message: str,
        target: str,
        title: str = DEFAULT_TITLE,
        timeout_seconds: float = 5,
        sender: Sender | None = None,
    ) -> Any:
        _validate_target(target)
        if sender:
            return sender(
                message=message,
                target=target,
                notification_config={
                    "channel": self.name,
                    "title": title,
                    "timeout_seconds": timeout_seconds,
                },
            )
        return _post_json(target, self.build_payload(message, title=title), timeout_seconds=timeout_seconds)


PROVIDER_ADAPTERS: dict[str, NotificationProviderAdapter] = {
    "feishu": FeishuNotificationAdapter(),
    "dingtalk": DingTalkNotificationAdapter(),
}


def create_notification_adapter(provider: str) -> NotificationProviderAdapter:
    name = str(provider or "").strip().lower()
    try:
        return PROVIDER_ADAPTERS[name]
    except KeyError as exc:
        raise ValueError(f"unknown notification provider: {provider!r}") from exc
