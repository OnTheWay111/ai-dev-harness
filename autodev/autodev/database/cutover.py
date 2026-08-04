"""Host-local persistence cutover receipt and rollback guard."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit

from autodev._internal.io import atomic_write_text, file_lock
from autodev.persistence import PersistenceConfigurationError

from .config import MODE_DATABASE


LEGACY_RECEIPT_SCHEMA_VERSION = 1
RECEIPT_SCHEMA_VERSION = 2
ACTIVE = "database"


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(
        character in "0123456789abcdef" for character in value
    )


def cutover_receipt_path(env: Mapping[str, str] | None = None) -> Path:
    env_map = os.environ if env is None else env
    state_home = str(env_map.get("XDG_STATE_HOME") or "").strip()
    if state_home:
        root = Path(state_home).expanduser()
    else:
        root = Path(str(env_map.get("HOME") or Path.home())).expanduser() / ".local" / "state"
    return root / "autodev" / "database-cutover.json"


def cutover_digest(evidence: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        dict(evidence),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _receipt_digest(receipt: Mapping[str, Any]) -> str:
    payload = deepcopy(dict(receipt))
    payload.pop("receipt_digest", None)
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _validated_project_entry(value: Any, *, source: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PersistenceConfigurationError(
            f"database cutover receipt project entry is invalid: {source}"
        )
    evidence = value.get("evidence")
    project_id = str(value.get("project_id") or "")
    repo_root = str(value.get("repo_root") or "")
    digest = str(value.get("cutover_digest") or "")
    activated_at = str(value.get("activated_at") or "")
    resolved_repo_root = str(
        Path(repo_root).expanduser().resolve(strict=False)
    )
    if (
        not isinstance(evidence, dict)
        or not project_id
        or project_id != project_id.strip()
        or not repo_root
        or repo_root != resolved_repo_root
        or not _is_sha256(digest)
        or not activated_at
        or evidence.get("project_id") != project_id
        or evidence.get("repo_root") != repo_root
        or cutover_digest(evidence) != digest
    ):
        raise PersistenceConfigurationError(
            f"database cutover receipt project evidence is invalid: {source}"
        )
    return {
        "project_id": project_id,
        "repo_root": repo_root,
        "activated_at": activated_at,
        "cutover_digest": digest,
        "evidence": deepcopy(evidence),
    }


def receipt_project_entries(receipt: Mapping[str, Any]) -> tuple[dict[str, Any], ...]:
    """Return validated project entries from a legacy or current receipt."""
    schema_version = receipt.get("schema_version")
    if isinstance(schema_version, bool):
        raise PersistenceConfigurationError(
            f"unsupported database cutover receipt schema: {schema_version!r}"
        )
    if schema_version == LEGACY_RECEIPT_SCHEMA_VERSION:
        entry = _validated_project_entry(
            {
                "project_id": (
                    receipt.get("evidence") or {}
                ).get("project_id")
                if isinstance(receipt.get("evidence"), dict)
                else "",
                "repo_root": (
                    receipt.get("evidence") or {}
                ).get("repo_root")
                if isinstance(receipt.get("evidence"), dict)
                else "",
                "activated_at": receipt.get("activated_at"),
                "cutover_digest": receipt.get("cutover_digest"),
                "evidence": receipt.get("evidence"),
            },
            source="legacy-v1",
        )
        return (entry,)
    if schema_version != RECEIPT_SCHEMA_VERSION:
        raise PersistenceConfigurationError(
            f"unsupported database cutover receipt schema: {schema_version!r}"
        )
    raw_entries = receipt.get("covered_projects")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise PersistenceConfigurationError(
            "database cutover receipt covered_projects is invalid"
        )
    entries = tuple(
        _validated_project_entry(item, source=f"covered_projects[{index}]")
        for index, item in enumerate(raw_entries)
    )
    project_ids = [entry["project_id"] for entry in entries]
    repo_roots = [entry["repo_root"] for entry in entries]
    if len(project_ids) != len(set(project_ids)):
        raise PersistenceConfigurationError(
            "database cutover receipt contains duplicate project ids"
        )
    if len(repo_roots) != len(set(repo_roots)):
        raise PersistenceConfigurationError(
            "database cutover receipt contains duplicate repo roots"
        )
    return entries


def covered_project_ids(receipt: Mapping[str, Any]) -> frozenset[str]:
    return frozenset(
        entry["project_id"] for entry in receipt_project_entries(receipt)
    )


def load_cutover_receipt(
    env: Mapping[str, str] | None = None,
) -> dict[str, Any] | None:
    path = cutover_receipt_path(env)
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PersistenceConfigurationError(
            f"database cutover receipt is unreadable: {path}"
        ) from exc
    if (
        not isinstance(value, dict)
        or value.get("schema_version")
        not in {LEGACY_RECEIPT_SCHEMA_VERSION, RECEIPT_SCHEMA_VERSION}
        or value.get("state") != ACTIVE
        or not _is_sha256(
            str(value.get("database_url_fingerprint") or "")
        )
    ):
        raise PersistenceConfigurationError(
            f"database cutover receipt is invalid: {path}"
        )
    if value.get("schema_version") == RECEIPT_SCHEMA_VERSION:
        stored_digest = str(value.get("receipt_digest") or "")
        if (
            not _is_sha256(stored_digest)
            or stored_digest != _receipt_digest(value)
        ):
            raise PersistenceConfigurationError(
                f"database cutover receipt integrity check failed: {path}"
            )
    receipt_project_entries(value)
    return value


def enforce_cutover_mode(
    selected_mode: str,
    env: Mapping[str, str] | None = None,
    *,
    database_url: str | None = None,
) -> None:
    receipt = load_cutover_receipt(env)
    if receipt is None:
        return
    state = str(receipt["state"])
    if state == ACTIVE and selected_mode != MODE_DATABASE:
        raise PersistenceConfigurationError(
            "database cutover is active; direct database-to-shadow/file fallback "
            "is forbidden; no automated reverse migration is available"
        )
    if (
        state == ACTIVE
        and receipt.get("database_url_fingerprint")
        not in _database_url_fingerprint_candidates(database_url or "")
    ):
        raise PersistenceConfigurationError(
            "selected database identity does not match the active cutover receipt"
        )


def enforce_cutover_project(
    project_id: str,
    repo_root: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> None:
    receipt = load_cutover_receipt(env)
    if receipt is None:
        raise PersistenceConfigurationError(
            "database project access requires an active cutover receipt"
        )
    entries = receipt_project_entries(receipt)
    selected = next(
        (entry for entry in entries if entry["project_id"] == project_id),
        None,
    )
    if selected is None:
        raise PersistenceConfigurationError(
            f"project {project_id!r} is not covered by the active cutover receipt"
        )
    if repo_root is not None:
        resolved = str(Path(repo_root).expanduser().resolve(strict=False))
        if selected["repo_root"] != resolved:
            raise PersistenceConfigurationError(
                "project repo root does not match the active cutover receipt"
            )


def _database_url_fingerprint(
    url: str,
    *,
    normalize_default_port: bool,
    omit_port: bool = False,
) -> str:
    parsed = urlsplit(url)
    port = None if omit_port else parsed.port
    if (
        normalize_default_port
        and port is None
        and parsed.scheme.lower().startswith("postgresql")
    ):
        port = 5432
    identity = json.dumps(
        {
            "scheme": parsed.scheme,
            "host": parsed.hostname or "",
            "port": port,
            "database": parsed.path,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def database_url_fingerprint(url: str) -> str:
    return _database_url_fingerprint(url, normalize_default_port=True)


def _database_url_fingerprint_candidates(url: str) -> frozenset[str]:
    """Accept pre-0.4.13 v1 fingerprints, then write only the canonical form."""
    parsed = urlsplit(url)
    candidates = {
        database_url_fingerprint(url),
        _database_url_fingerprint(
            url,
            normalize_default_port=False,
        ),
    }
    if (
        parsed.scheme.lower().startswith("postgresql")
        and parsed.port in {None, 5432}
    ):
        candidates.add(
            _database_url_fingerprint(
                url,
                normalize_default_port=False,
                omit_port=True,
            )
        )
    return frozenset(candidates)


def activate_cutover(
    evidence: Mapping[str, Any],
    *,
    expected_digest: str,
    database_url: str,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    canonical_evidence = json.loads(
        json.dumps(dict(evidence), ensure_ascii=False, default=str)
    )
    actual_digest = cutover_digest(canonical_evidence)
    if not expected_digest or expected_digest != actual_digest:
        raise PersistenceConfigurationError(
            "cutover confirmation digest does not match current frozen evidence"
        )
    project_id = str(canonical_evidence.get("project_id") or "")
    repo_root = str(canonical_evidence.get("repo_root") or "")
    if not project_id or not repo_root:
        raise PersistenceConfigurationError(
            "cutover evidence requires project_id and repo_root"
        )
    now = datetime.now().astimezone().isoformat()
    database_fingerprint = database_url_fingerprint(database_url)
    new_entry = _validated_project_entry(
        {
            "project_id": project_id,
            "repo_root": repo_root,
            "activated_at": now,
            "cutover_digest": actual_digest,
            "evidence": canonical_evidence,
        },
        source="activation",
    )
    path = cutover_receipt_path(env)
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(path):
        existing = load_cutover_receipt(env)
        if (
            existing is not None
            and existing.get("database_url_fingerprint")
            not in _database_url_fingerprint_candidates(database_url)
        ):
            raise PersistenceConfigurationError(
                "an incompatible database cutover receipt already exists"
            )
        entries = list(receipt_project_entries(existing)) if existing else []
        for entry in entries:
            same_project = entry["project_id"] == project_id
            same_repo = entry["repo_root"] == repo_root
            if same_project or same_repo:
                if (
                    not same_project
                    or not same_repo
                    or entry["cutover_digest"] != actual_digest
                    or entry["evidence"] != canonical_evidence
                ):
                    raise PersistenceConfigurationError(
                        "an incompatible database cutover project entry already exists"
                    )
                # Preserve the original activation timestamp on idempotent
                # replay, including a v1-to-v2 upgrade.
                new_entry = entry
                break
        else:
            entries.append(new_entry)
        if new_entry not in entries:
            entries.append(new_entry)
        entries.sort(key=lambda item: (item["project_id"], item["repo_root"]))
        receipt = {
            "schema_version": RECEIPT_SCHEMA_VERSION,
            "state": ACTIVE,
            "activated_at": (
                str(existing.get("activated_at") or now) if existing else now
            ),
            "updated_at": now,
            "database_url_fingerprint": database_fingerprint,
            "covered_projects": entries,
        }
        receipt["receipt_digest"] = _receipt_digest(receipt)
        # Validate the entire replacement before the atomic rename.
        receipt_project_entries(receipt)
        if (
            existing is not None
            and existing.get("schema_version") == RECEIPT_SCHEMA_VERSION
        ):
            if (
                receipt["covered_projects"] == existing.get("covered_projects")
                and existing.get("database_url_fingerprint")
                == database_fingerprint
            ):
                # Exact replays must not churn the receipt or its mtime.
                path.chmod(0o600)
                return existing
        atomic_write_text(
            path,
            json.dumps(
                receipt,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
                default=str,
            )
            + "\n",
        )
        path.chmod(0o600)
    return receipt
