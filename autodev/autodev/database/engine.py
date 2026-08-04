"""SQLAlchemy engine and explicit unit-of-work support."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

try:
    from sqlalchemy import Engine, create_engine, event, text
    from sqlalchemy.orm import Session, sessionmaker
    from sqlalchemy.pool import StaticPool
except ImportError as exc:  # pragma: no cover - exercised without optional extra
    raise RuntimeError(
        "database persistence requires the autodev-harness[postgres] extra"
    ) from exc

from .config import DatabaseConfig, DatabaseConfigError


def create_db_engine(config: DatabaseConfig) -> Engine:
    url = config.require_url()
    if config.is_sqlite and not config.allow_sqlite:
        raise DatabaseConfigError("SQLite is restricted to explicit test mode")
    options: dict[str, Any] = {"future": True, "pool_pre_ping": True}
    if config.is_sqlite:
        options["connect_args"] = {"check_same_thread": False}
        if ":memory:" in url:
            options["poolclass"] = StaticPool
    else:
        options.update(
            pool_size=config.pool_size,
            max_overflow=config.max_overflow,
            pool_timeout=config.pool_timeout,
        )
    options.update(config.extra_engine_options)
    if config.is_production:
        options["echo"] = False
        options["hide_parameters"] = True
    engine = create_engine(url, **options)
    if config.is_sqlite:
        @event.listens_for(engine, "connect")
        def _enable_sqlite_foreign_keys(connection, _record):
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()
    return engine


class Database:
    def __init__(self, engine: Engine, config: DatabaseConfig | None = None) -> None:
        self.engine = engine
        self.config = config
        self._sessions = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    @classmethod
    def from_config(cls, config: DatabaseConfig) -> "Database":
        return cls(create_db_engine(config), config=config)

    @contextmanager
    def unit_of_work(self) -> Iterator[Session]:
        session = self._sessions()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    @contextmanager
    def connect(self):
        with self.engine.connect() as connection:
            yield connection

    def ping(self) -> bool:
        with self.engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True

    def dispose(self) -> None:
        self.engine.dispose()
