"""Project safety policy checks for AutoDev preflight."""
from __future__ import annotations

import fnmatch
import os
from pathlib import Path
import re
import subprocess

from autodev.config import AutoDevConfig


def _is_runtime_artifact_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return (
        normalized.startswith(".autodev/runs/")
        or normalized.startswith(".autodev/runtime/")
        or normalized == ".autodev/latest_handoff.md"
        or normalized.startswith("outputs/autodev/")
    )


class PolicyGitReadError(RuntimeError):
    """Raised when a git read backing a safety check cannot be trusted.

    Safety checks (forbidden_paths / secret_patterns) are only meaningful when
    the diff/status they scan was actually produced. A failed read must never be
    treated as an empty (clean) diff, or the checks would silently pass.
    """


def _git_text(repo_root: Path, args: list[str]) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(repo_root),
            check=False,
            capture_output=True,
            text=True,
            errors="replace",
        )
    except OSError as exc:
        raise PolicyGitReadError(f"git {' '.join(args)} failed to launch: {exc}") from exc
    # `git diff` returns 0 (or 1 with --exit-code) on success; anything else
    # (128 fatal, negative signal) means the read is untrustworthy.
    if result.returncode not in (0, 1):
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        reason = detail[0] if detail else f"exit code {result.returncode}"
        raise PolicyGitReadError(f"git {' '.join(args)} exited {result.returncode}: {reason}")
    return result.stdout


def _untracked_paths(repo_root: Path) -> list[str]:
    # Runtime artifacts are never task commit candidates while untracked. If a
    # project intentionally tracks historical output at these paths, the normal
    # git diff below still includes every modification for policy/review.
    return [
        line.strip()
        for line in _git_text(repo_root, ["ls-files", "--others", "--exclude-standard"]).splitlines()
        if line.strip() and not _is_runtime_artifact_path(line.strip())
    ]


def _changed_paths(repo_root: Path, *, base_ref: str = "") -> list[str]:
    paths: list[str] = []
    diff_commands = (
        [["diff", "--name-only", base_ref, "--", "."]]
        if base_ref
        else [
            ["diff", "--name-only", "--", "."],
            ["diff", "--cached", "--name-only", "--", "."],
        ]
    )
    for args in diff_commands:
        for line in _git_text(repo_root, args).splitlines():
            value = line.strip()
            if value:
                paths.append(value)
    paths.extend(_untracked_paths(repo_root))
    return list(dict.fromkeys(paths))


def _diff_text(repo_root: Path, *, base_ref: str = "") -> str:
    chunks = (
        [
            _git_text(
                repo_root,
                ["diff", "--unified=0", "--no-ext-diff", base_ref, "--", "."],
            )
        ]
        if base_ref
        else [
            _git_text(
                repo_root,
                ["diff", "--unified=0", "--no-ext-diff", "--", "."],
            ),
            _git_text(
                repo_root,
                ["diff", "--cached", "--unified=0", "--no-ext-diff", "--", "."],
            ),
        ]
    )
    # Untracked files are absent from ordinary git diff output. Include them in
    # the safety scan without changing the index; symlinks are represented by
    # their link text rather than following them outside the worktree.
    for path in _untracked_paths(repo_root):
        chunks.append(
            _git_text(
                repo_root,
                ["diff", "--no-index", "--unified=0", "--no-ext-diff", "--", os.devnull, path],
            )
        )
    return "\n".join(chunk for chunk in chunks if chunk)


def _path_matches(path: str, pattern: str) -> bool:
    normalized = path.replace("\\", "/")
    normalized_pattern = pattern.replace("\\", "/")
    return fnmatch.fnmatch(normalized, normalized_pattern) or normalized.startswith(normalized_pattern.rstrip("/") + "/")


def _external_write_errors(config: AutoDevConfig) -> list[str]:
    errors: list[str] = []
    policy = config.safety.external_write_policy
    real_notifications = str(config.notifications.mode or "").strip().lower() == "real"
    if not config.safety.declared:
        if config.branch.push:
            errors.append("branch.push=true requires an explicit safety.external_write_policy")
        if real_notifications:
            errors.append("notifications.mode=real requires an explicit safety.external_write_policy")
        return errors
    if policy == "dry_run_only":
        if config.branch.push:
            errors.append("branch.push=true is blocked by safety.external_write_policy=dry_run_only")
        if real_notifications:
            errors.append("notifications.mode=real is blocked by safety.external_write_policy=dry_run_only")
    elif policy == "notifications_only" and config.branch.push:
        errors.append("branch.push=true is blocked by safety.external_write_policy=notifications_only")
    return errors


def check_project_safety_policy(
    config: AutoDevConfig,
    *,
    repo_root: Path | None = None,
    base_ref: str = "",
) -> list[str]:
    target_root = Path(repo_root or config.project.repo_root)
    errors = _external_write_errors(config)
    try:
        changed_paths = _changed_paths(target_root, base_ref=base_ref)
        diff_text = _diff_text(target_root, base_ref=base_ref)
    except PolicyGitReadError as exc:
        # Fail closed: a broken git read cannot be allowed to look like an empty
        # diff, which would silently skip forbidden_paths / secret_patterns.
        errors.append(f"safety policy git read failed: {exc}")
        return errors
    for changed_path in changed_paths:
        for pattern in config.safety.forbidden_paths:
            if _path_matches(changed_path, pattern):
                errors.append(f"changed path is forbidden by safety.forbidden_paths: {changed_path} matches {pattern}")

    for pattern in config.safety.secret_patterns:
        try:
            regex = re.compile(pattern)
        except re.error as exc:
            errors.append(f"invalid safety.secret_patterns regex {pattern!r}: {exc}")
            continue
        match = regex.search(diff_text)
        if match:
            errors.append(f"diff matches safety.secret_patterns: {pattern}")
    return errors
