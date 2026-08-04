"""Optional PostgreSQL persistence support.

Importing :mod:`autodev.database.config` remains dependency-light.  Engine,
models, and migration modules require the ``autodev-harness[postgres]`` extra.
"""

from .config import (
    AUTODEV_DATABASE_URL_ENV,
    AUTODEV_PERSISTENCE_MODE_ENV,
    DatabaseConfig,
    DatabaseConfigError,
    load_database_config,
)

__all__ = [
    "AUTODEV_DATABASE_URL_ENV",
    "AUTODEV_PERSISTENCE_MODE_ENV",
    "DatabaseConfig",
    "DatabaseConfigError",
    "load_database_config",
]
