"""Shared schema-version guardrails for AutoDev's v1 YAML documents."""
from __future__ import annotations

import warnings
from typing import TypeVar


SCHEMA_VERSION = 1
ErrorT = TypeVar("ErrorT", bound=Exception)


class SchemaMigrationWarning(UserWarning):
    """Warn that a legacy document without a version was interpreted as v1."""


def ensure_schema_v1(
    document: dict,
    *,
    label: str,
    error_type: type[ErrorT] = ValueError,
) -> int:
    """Normalize a missing version to v1 and reject every explicit non-v1 value."""
    if "schema_version" not in document:
        warnings.warn(
            f"{label} is missing schema_version; treating it as v1. "
            "Persist schema_version: 1 before the document is written again.",
            SchemaMigrationWarning,
            stacklevel=3,
        )
        document["schema_version"] = SCHEMA_VERSION

    version = document.get("schema_version")
    if type(version) is not int or version != SCHEMA_VERSION:
        raise error_type(
            f"unsupported {label} schema_version: {version!r}; expected {SCHEMA_VERSION}"
        )
    return SCHEMA_VERSION
