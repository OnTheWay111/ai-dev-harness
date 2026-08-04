"""Fail-closed configuration for optional AutoDev PostgreSQL persistence."""
from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
import re
from typing import Any, Mapping
from urllib.parse import parse_qsl, urlencode, urlsplit

import yaml

from autodev.host_capacity import default_host_policy_path
from autodev.persistence import PersistenceConfigurationError


AUTODEV_DATABASE_URL_ENV = "AUTODEV_DATABASE_URL"
AUTODEV_PERSISTENCE_MODE_ENV = "AUTODEV_PERSISTENCE_MODE"
AUTODEV_DB_POOL_SIZE_ENV = "AUTODEV_DB_POOL_SIZE"
AUTODEV_DB_MAX_OVERFLOW_ENV = "AUTODEV_DB_MAX_OVERFLOW"
AUTODEV_DB_POOL_TIMEOUT_ENV = "AUTODEV_DB_POOL_TIMEOUT"

MODE_FILE = "file"
MODE_SHADOW = "shadow"
MODE_DATABASE = "database"
MODE_TEST = "test"
VALID_MODES = (MODE_FILE, MODE_SHADOW, MODE_DATABASE)
PRODUCTION_MODES = (MODE_SHADOW, MODE_DATABASE)
DATABASE_ACTIVE_MODES = (MODE_SHADOW, MODE_DATABASE, MODE_TEST)
PRODUCTION_URL_SCHEME = "postgresql+psycopg"
SENSITIVE_QUERY_KEYS = frozenset(
    {"password", "passwd", "pwd", "secret", "token", "sslpassword", "sslkey"}
)
PERSISTENCE_KEYS = frozenset({"mode", "database_url_env", "artifact_store"})
ENV_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class DatabaseConfigError(PersistenceConfigurationError):
    """Database mode is missing required or safe configuration."""


def _load_host_persistence(
    env: Mapping[str, str], host_path: str | Path | None
) -> dict[str, Any]:
    selected = Path(host_path).expanduser() if host_path else default_host_policy_path(env)
    if not selected.exists():
        return {}
    try:
        payload = yaml.safe_load(selected.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise DatabaseConfigError(f"cannot read host persistence config: {selected}") from exc
    if not isinstance(payload, dict):
        raise DatabaseConfigError("host config must be a mapping")
    if payload.get("schema_version", 1) != 1:
        raise DatabaseConfigError("unsupported host persistence schema_version")
    persistence = payload.get("persistence") or {}
    if not isinstance(persistence, dict):
        raise DatabaseConfigError("host persistence must be a mapping")
    unknown = set(persistence) - PERSISTENCE_KEYS
    if unknown:
        raise DatabaseConfigError(
            f"host persistence contains unsupported keys: {sorted(unknown)}"
        )
    artifact_store = str(persistence.get("artifact_store") or "local").strip().lower()
    if artifact_store != "local":
        raise DatabaseConfigError("host persistence.artifact_store must be 'local'")
    return dict(persistence)


def requested_persistence_mode(
    env: Mapping[str, str] | None = None,
    *,
    host_path: str | Path | None = None,
) -> str | None:
    """Best-effort mode hint used to distinguish database from shadow failure.

    This intentionally ignores unrelated persistence validation. ``None`` means
    the host document was unreadable or its mode could not be determined.
    """
    env_map = os.environ if env is None else env
    override = str(env_map.get(AUTODEV_PERSISTENCE_MODE_ENV) or "").strip().lower()
    if override:
        return override
    selected = Path(host_path).expanduser() if host_path else default_host_policy_path(env_map)
    if not selected.exists():
        return MODE_FILE
    try:
        payload = yaml.safe_load(selected.read_text(encoding="utf-8")) or {}
        if not isinstance(payload, dict):
            return None
        persistence = payload.get("persistence") or {}
        if not isinstance(persistence, dict):
            return None
        return str(persistence.get("mode") or MODE_FILE).strip().lower()
    except (OSError, yaml.YAMLError):
        return None


def is_sqlite_url(url: str | None) -> bool:
    if not url:
        return False
    scheme = urlsplit(url).scheme.lower()
    return scheme == "sqlite" or scheme.startswith("sqlite+")


def redact_url(url: str | None) -> str:
    if not url:
        return ""
    try:
        parts = urlsplit(url)
        userinfo = ""
        if parts.username or parts.password is not None:
            username = parts.username or ""
            userinfo = f"{username}:***@" if parts.password is not None else f"{username}@"
        host = parts.hostname or ""
        if parts.port:
            host = f"{host}:{parts.port}"
        rebuilt = f"{parts.scheme}://{userinfo}{host}{parts.path}"
        if parts.query:
            redacted = [
                (key, "***" if key.lower() in SENSITIVE_QUERY_KEYS else value)
                for key, value in parse_qsl(parts.query, keep_blank_values=True)
            ]
            rebuilt = f"{rebuilt}?{urlencode(redacted)}"
        return rebuilt
    except (TypeError, ValueError):
        return "<unparseable-url>"


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = str(env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise DatabaseConfigError(f"{name} must be an integer") from exc
    if value <= 0:
        raise DatabaseConfigError(f"{name} must be positive")
    return value


def _nonnegative_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = str(env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise DatabaseConfigError(f"{name} must be an integer") from exc
    if value < 0:
        raise DatabaseConfigError(f"{name} must be nonnegative")
    return value


@dataclass(frozen=True)
class DatabaseConfig:
    url: str | None
    mode: str
    allow_sqlite: bool = False
    pool_size: int = 5
    max_overflow: int = 10
    pool_timeout: int = 30
    extra_engine_options: dict[str, Any] = field(default_factory=dict)

    @property
    def uses_database(self) -> bool:
        return self.mode in DATABASE_ACTIVE_MODES

    @property
    def is_production(self) -> bool:
        return self.mode in PRODUCTION_MODES

    @property
    def is_sqlite(self) -> bool:
        return is_sqlite_url(self.url)

    @property
    def safe_url(self) -> str:
        return redact_url(self.url)

    def require_url(self) -> str:
        if not self.url:
            raise DatabaseConfigError(
                f"database mode {self.mode!r} requires {AUTODEV_DATABASE_URL_ENV}; "
                "refusing an implicit SQLite fallback"
            )
        return self.url

    @classmethod
    def for_sqlite(cls, url: str = "sqlite+pysqlite:///:memory:") -> "DatabaseConfig":
        if not is_sqlite_url(url):
            raise DatabaseConfigError("for_sqlite requires a SQLite URL")
        return cls(url=url, mode=MODE_TEST, allow_sqlite=True)


def load_database_config(
    env: Mapping[str, str] | None = None,
    *,
    host_path: str | Path | None = None,
    allow_unactivated_database: bool = False,
) -> DatabaseConfig:
    env_map = os.environ if env is None else env
    persistence = _load_host_persistence(env_map, host_path)
    configured_mode = str(persistence.get("mode") or MODE_FILE).strip().lower()
    mode_override = str(env_map.get(AUTODEV_PERSISTENCE_MODE_ENV) or "").strip().lower()
    mode = mode_override or configured_mode
    if mode not in VALID_MODES:
        raise DatabaseConfigError(
            f"{AUTODEV_PERSISTENCE_MODE_ENV} must be one of {VALID_MODES}, got {mode!r}"
        )
    if mode == MODE_DATABASE and mode_override != MODE_DATABASE:
        raise DatabaseConfigError(
            "database cutover must be declared explicitly with "
            f"{AUTODEV_PERSISTENCE_MODE_ENV}=database"
        )
    if configured_mode == MODE_DATABASE and mode_override not in {
        MODE_DATABASE,
        MODE_SHADOW,
    }:
        raise DatabaseConfigError(
            "host database mode cannot fall directly back to file; explicitly "
            "select database or the rollback staging mode shadow"
        )
    database_url_env = str(
        persistence.get("database_url_env") or AUTODEV_DATABASE_URL_ENV
    ).strip()
    if not ENV_NAME_PATTERN.fullmatch(database_url_env):
        raise DatabaseConfigError(
            "host persistence.database_url_env must be an environment variable name"
        )
    url = str(env_map.get(database_url_env) or "").strip() or None
    if mode in PRODUCTION_MODES:
        if not url:
            raise DatabaseConfigError(
                f"persistence mode {mode!r} requires {database_url_env}; "
                "no implicit SQLite fallback is allowed"
            )
        if is_sqlite_url(url):
            raise DatabaseConfigError("shadow/database modes require PostgreSQL, not SQLite")
        scheme = urlsplit(url).scheme.lower()
        if scheme != PRODUCTION_URL_SCHEME:
            raise DatabaseConfigError(
                f"shadow/database modes only support {PRODUCTION_URL_SCHEME}:// URLs, "
                f"got {scheme!r}"
            )
    selected = DatabaseConfig(
        url=url,
        mode=mode,
        allow_sqlite=False,
        pool_size=_positive_int(env_map, AUTODEV_DB_POOL_SIZE_ENV, 5),
        max_overflow=_nonnegative_int(env_map, AUTODEV_DB_MAX_OVERFLOW_ENV, 10),
        pool_timeout=_positive_int(env_map, AUTODEV_DB_POOL_TIMEOUT_ENV, 30),
    )
    from .cutover import enforce_cutover_mode, load_cutover_receipt

    if (
        selected.mode == MODE_DATABASE
        and load_cutover_receipt(env_map) is None
        and not allow_unactivated_database
    ):
        raise DatabaseConfigError(
            "database mode is not activated; run prepare-cutover and "
            "activate-cutover with the confirmed digest"
        )
    enforce_cutover_mode(
        selected.mode,
        env_map,
        database_url=selected.url,
    )
    return selected
