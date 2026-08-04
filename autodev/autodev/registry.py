"""XDG project registry loading, migration, and locked updates."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import sys
from typing import Any, Mapping
import warnings

import yaml

from autodev._internal.io import atomic_write_yaml, file_lock
from autodev.config import AutoDevConfig, AutoDevConfigError, expand_path, load_autodev_config, xdg_config_home


LEGACY_REGISTRY_RELATIVE = Path("config/autodev.projects.yaml")


class AutoDevRegistryError(ValueError):
    """Raised when an AutoDev project registry is malformed."""


class LegacyRegistryWarning(UserWarning):
    """Warn that a legacy repository-local registry is being read."""


@dataclass(frozen=True)
class ProjectRegistryEntry:
    id: str
    name: str
    config_path: Path
    enabled: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "config_path": str(self.config_path),
            "enabled": self.enabled,
        }


@dataclass(frozen=True)
class RegistryMigrationResult:
    source: Path
    target: Path
    added: tuple[str, ...]
    unchanged: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": str(self.source),
            "target": str(self.target),
            "added": list(self.added),
            "unchanged": list(self.unchanged),
        }


def default_registry_path(env: Mapping[str, str] | None = None) -> Path:
    return (xdg_config_home(env) / "autodev" / "projects.yaml").resolve(strict=False)


# Compatibility alias for callers that only display the default. Load/update
# functions resolve the path at call time so XDG/HOME overrides still work.
DEFAULT_REGISTRY_PATH = default_registry_path()


def resolve_registry_path(
    path: str | Path | None = None,
    *,
    legacy_path: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> Path:
    if path:
        return expand_path(path).resolve(strict=False)
    target = default_registry_path(env)
    legacy = expand_path(legacy_path).resolve(strict=False) if legacy_path else None
    if not target.exists() and legacy and legacy.exists():
        warnings.warn(
            f"legacy AutoDev registry is read-only: {legacy}; migrate it with "
            f"autodev registry migrate --legacy {legacy} --registry {target}",
            LegacyRegistryWarning,
            stacklevel=2,
        )
        return legacy
    return target


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"AutoDev project registry not found: {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise AutoDevRegistryError(f"AutoDev project registry must be a mapping: {path}")
    return data


def _resolve_config_path(registry_path: Path, value: str) -> Path:
    path = expand_path(value)
    if "$" in str(path):
        raise AutoDevRegistryError("project config path contains unresolved environment variables")
    if not path.is_absolute():
        path = registry_path.parent / path
    return path.resolve(strict=False)


def _parse_entries(raw: dict[str, Any], registry_path: Path) -> list[ProjectRegistryEntry]:
    projects = raw.get("projects")
    if not isinstance(projects, list):
        raise AutoDevRegistryError("projects must be a list")
    entries: list[ProjectRegistryEntry] = []
    seen: set[str] = set()
    for index, item in enumerate(projects):
        if not isinstance(item, dict):
            raise AutoDevRegistryError(f"projects[{index}] must be a mapping")
        project_id = str(item.get("id") or "").strip()
        if not project_id:
            raise AutoDevRegistryError(f"projects[{index}].id is required")
        if project_id in seen:
            raise AutoDevRegistryError(f"duplicate project id: {project_id}")
        seen.add(project_id)
        config_value = str(item.get("config") or item.get("config_path") or "").strip()
        if not config_value:
            raise AutoDevRegistryError(f"projects[{index}].config is required")
        enabled = item.get("enabled", True)
        if not isinstance(enabled, bool):
            raise AutoDevRegistryError(f"projects[{index}].enabled must be a boolean")
        entries.append(
            ProjectRegistryEntry(
                id=project_id,
                name=str(item.get("name") or project_id),
                config_path=_resolve_config_path(registry_path, config_value),
                enabled=enabled,
            )
        )
    return entries


def load_project_registry(
    path: str | Path | None = None,
    *,
    legacy_path: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> list[ProjectRegistryEntry]:
    registry_path = resolve_registry_path(path, legacy_path=legacy_path, env=env)
    return _parse_entries(_read_yaml(registry_path), registry_path)


def load_registry_project_configs(
    path: str | Path | None = None,
    *,
    include_disabled: bool = False,
    legacy_path: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> list[tuple[ProjectRegistryEntry, AutoDevConfig | None, str]]:
    loaded: list[tuple[ProjectRegistryEntry, AutoDevConfig | None, str]] = []
    for entry in load_project_registry(path, legacy_path=legacy_path, env=env):
        if not entry.enabled:
            if include_disabled:
                loaded.append((entry, None, "disabled"))
            continue
        if not entry.config_path.exists():
            loaded.append((entry, None, f"config not found: {entry.config_path}"))
            continue
        try:
            loaded.append((entry, load_autodev_config(entry.config_path, merge_example=False), ""))
        except (AutoDevConfigError, FileNotFoundError, OSError) as exc:
            loaded.append((entry, None, str(exc)))
    return loaded


def _serialized_entry(entry: ProjectRegistryEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "name": entry.name,
        "config": str(entry.config_path),
        "enabled": entry.enabled,
    }


def upsert_project_registry(
    entry: ProjectRegistryEntry,
    path: str | Path | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> Path:
    """Insert or replace one entry using a locked read-modify-write."""
    target = resolve_registry_path(path, env=env)
    with file_lock(target):
        raw = _read_yaml(target) if target.exists() else {"schema_version": 1, "projects": []}
        existing = _parse_entries(raw, target)
        by_id = {item.id: _serialized_entry(item) for item in existing}
        by_id[entry.id] = _serialized_entry(entry)
        raw["schema_version"] = 1
        raw["projects"] = list(by_id.values())
        atomic_write_yaml(target, raw)
    return target


def migrate_legacy_registry(
    legacy_path: str | Path,
    target_path: str | Path | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> RegistryMigrationResult:
    """Merge a legacy registry into XDG without ever writing the source."""
    source = expand_path(legacy_path).resolve(strict=False)
    source_entries = load_project_registry(source)
    target = resolve_registry_path(target_path, env=env)
    added: list[str] = []
    unchanged: list[str] = []
    with file_lock(target):
        raw = _read_yaml(target) if target.exists() else {"schema_version": 1, "projects": []}
        target_entries = _parse_entries(raw, target)
        by_id = {entry.id: _serialized_entry(entry) for entry in target_entries}
        for entry in source_entries:
            serialized = _serialized_entry(entry)
            if entry.id in by_id:
                if by_id[entry.id] != serialized:
                    raise AutoDevRegistryError(
                        f"registry migration conflict for project id {entry.id}: target entry differs"
                    )
                unchanged.append(entry.id)
            else:
                by_id[entry.id] = serialized
                added.append(entry.id)
        raw["schema_version"] = 1
        raw["projects"] = list(by_id.values())
        atomic_write_yaml(target, raw)
    return RegistryMigrationResult(source, target, tuple(added), tuple(unchanged))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspect or migrate the AutoDev project registry")
    sub = parser.add_subparsers(dest="command", required=True)
    list_parser = sub.add_parser("list", help="List projects from XDG or an explicit registry")
    list_parser.add_argument("--registry", default="", help="Registry override")
    list_parser.add_argument("--legacy", default="", help="Read-only legacy fallback path")
    list_parser.add_argument("--json", action="store_true")
    migrate = sub.add_parser("migrate", help="Merge a legacy registry into XDG")
    migrate.add_argument("--legacy", required=True, help="Legacy registry path (read-only)")
    migrate.add_argument("--registry", default="", help="Target override; defaults to XDG")
    migrate.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "list":
            entries = load_project_registry(args.registry or None, legacy_path=args.legacy or None)
            payload: Any = [entry.to_dict() for entry in entries]
        else:
            payload = migrate_legacy_registry(args.legacy, args.registry or None).to_dict()
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        else:
            print(yaml.safe_dump(payload, allow_unicode=True, sort_keys=False).rstrip())
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
