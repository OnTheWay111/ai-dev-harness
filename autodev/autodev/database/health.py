"""Database connectivity and migration health without credential leakage."""
from __future__ import annotations

from dataclasses import asdict, dataclass

from .config import DatabaseConfig
from .engine import Database
from .migration import current_revision, head_revision


@dataclass(frozen=True)
class DatabaseHealth:
    ok: bool
    mode: str
    connected: bool
    dialect: str
    current_revision: str | None
    head_revision: str | None
    up_to_date: bool
    safe_url: str
    error: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def check_database_health(database: Database, config: DatabaseConfig) -> DatabaseHealth:
    head = head_revision()
    dialect = database.engine.dialect.name
    try:
        database.ping()
    except Exception as exc:
        return DatabaseHealth(
            ok=False,
            mode=config.mode,
            connected=False,
            dialect=dialect,
            current_revision=None,
            head_revision=head,
            up_to_date=False,
            safe_url=config.safe_url,
            error=f"{type(exc).__name__}: database connection failed",
        )
    try:
        current = current_revision(database)
        up_to_date = current == head
        return DatabaseHealth(
            ok=up_to_date,
            mode=config.mode,
            connected=True,
            dialect=dialect,
            current_revision=current,
            head_revision=head,
            up_to_date=up_to_date,
            safe_url=config.safe_url,
            error="" if up_to_date else "database migration is not at head",
        )
    except Exception as exc:
        return DatabaseHealth(
            ok=False,
            mode=config.mode,
            connected=True,
            dialect=dialect,
            current_revision=None,
            head_revision=head,
            up_to_date=False,
            safe_url=config.safe_url,
            error=f"{type(exc).__name__}: database migration check failed",
        )
