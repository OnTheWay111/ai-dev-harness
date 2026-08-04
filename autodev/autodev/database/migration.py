"""Programmatic Alembic configuration for packaged migrations."""
from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory

from .config import DatabaseConfig
from .engine import Database


MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def alembic_config(database_config: DatabaseConfig | None = None) -> Config:
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    config.set_main_option("prepend_sys_path", str(Path(__file__).resolve().parents[2]))
    config.set_main_option("path_separator", "os")
    if database_config is not None:
        config.attributes["database_config"] = database_config
    return config


def upgrade(
    revision: str = "head", *, database_config: DatabaseConfig | None = None
) -> None:
    command.upgrade(alembic_config(database_config), revision)


def downgrade(revision: str, *, database_config: DatabaseConfig | None = None) -> None:
    command.downgrade(alembic_config(database_config), revision)


def head_revision() -> str | None:
    return ScriptDirectory.from_config(alembic_config()).get_current_head()


def current_revision(database: Database) -> str | None:
    with database.connect() as connection:
        return MigrationContext.configure(
            connection,
            opts={"version_table": "autodev_alembic_version"},
        ).get_current_revision()
