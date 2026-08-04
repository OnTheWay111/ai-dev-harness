"""Time helpers kept independent from any project manifest schema."""
from __future__ import annotations

from datetime import datetime


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")
