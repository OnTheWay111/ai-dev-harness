from __future__ import annotations

from alembic import context

from autodev.database.config import load_database_config
from autodev.database.engine import create_db_engine
from autodev.database.models import Base


target_metadata = Base.metadata


def run_migrations_offline() -> None:
    config = context.config.attributes.get("database_config") or load_database_config()
    context.configure(
        url=config.require_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        version_table="autodev_alembic_version",
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    config = context.config.attributes.get("database_config") or load_database_config()
    engine = create_db_engine(config)
    try:
        with engine.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                version_table="autodev_alembic_version",
                compare_type=True,
            )
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
