"""Git worktree and checkpoint helpers for AutoDev."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import re
import shlex
import shutil
import subprocess
from typing import Any

from autodev.config import AutoDevConfig
from autodev.run_store import validate_run_id
from autodev.verify import VerifyGateResult


class AutoDevGitError(RuntimeError):
    """Raised when AutoDev git isolation or checkpointing fails."""


@dataclass(frozen=True)
class GitCommandResult:
    command: list[str]
    cwd: Path
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


@dataclass(frozen=True)
class WorktreeContext:
    path: Path
    branch: str
    base_ref: str
    base_sha: str
    isolated: bool
    integration_branch: str = ""
    integration_base_sha: str = ""


def run_git(cwd: Path, *args: str, timeout_seconds: int = 120) -> GitCommandResult:
    command = ["git", *args]
    proc = subprocess.run(
        command,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    return GitCommandResult(command=command, cwd=cwd, returncode=proc.returncode, stdout=proc.stdout, stderr=proc.stderr)


def _require_git(cwd: Path, *args: str, timeout_seconds: int = 120) -> GitCommandResult:
    result = run_git(cwd, *args, timeout_seconds=timeout_seconds)
    if not result.ok:
        raise AutoDevGitError(result.stderr.strip() or result.stdout.strip() or f"git {' '.join(args)} failed")
    return result


def _slug(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip())
    return cleaned.strip("-") or "project"


def integration_branch(config: AutoDevConfig, *, today: str | None = None) -> str:
    today = today or datetime.now().strftime("%Y%m%d")
    return config.branch.name_template.format(project_id=config.project.id, date=today)


def worktree_path(config: AutoDevConfig, run_id: str) -> Path:
    run_id = validate_run_id(run_id)
    return config.branch.worktree.root / f"{_slug(config.project.id)}-{_slug(run_id)}"


def run_branch(config: AutoDevConfig, run_id: str) -> str:
    run_id = validate_run_id(run_id)
    prefix = config.branch.prefix.strip().rstrip("/") or "autodev"
    return f"{prefix}/runs/{_slug(config.project.id)}/{_slug(run_id)}"


def _branch_exists(repo_root: Path, branch: str) -> bool:
    return run_git(repo_root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0


def _worktree_for_branch(repo_root: Path, branch: str) -> Path | None:
    result = _require_git(repo_root, "worktree", "list", "--porcelain")
    current_path: Path | None = None
    for line in result.stdout.splitlines():
        if line.startswith("worktree "):
            current_path = Path(line[len("worktree ") :])
        elif line == f"branch refs/heads/{branch}" and current_path:
            return current_path
    return None


def _ensure_worktree(config: AutoDevConfig, run_id: str, branch: str, start_sha: str) -> Path:
    repo_root = config.project.repo_root
    target = worktree_path(config, run_id)
    existing_for_branch = _worktree_for_branch(repo_root, branch)
    if existing_for_branch is not None:
        raise AutoDevGitError(
            f"run branch is already registered to a worktree and cannot be reused: "
            f"{branch} -> {existing_for_branch}; use a new run_id"
        )

    if target.exists():
        raise AutoDevGitError(f"run worktree path already exists and cannot be reused: {target}")

    target.parent.mkdir(parents=True, exist_ok=True)
    if _branch_exists(repo_root, branch):
        raise AutoDevGitError(f"run branch already exists and cannot be reused: {branch}")
    result = run_git(repo_root, "worktree", "add", "-b", branch, str(target), start_sha, timeout_seconds=180)
    if not result.ok:
        raise AutoDevGitError(result.stderr.strip() or result.stdout.strip() or "git worktree add failed")
    return target


def _validate_integration_branch(config: AutoDevConfig, branch: str) -> None:
    repo_root = config.project.repo_root
    current_branch = _require_git(repo_root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if branch in {config.branch.base_ref, current_branch}:
        raise AutoDevGitError(
            f"branch.name_template resolves to protected main/base branch {branch!r}; "
            "worktree isolation would be false"
        )
    registered = _worktree_for_branch(repo_root, branch)
    if registered is not None:
        raise AutoDevGitError(
            f"integration branch {branch} is checked out in an existing worktree {registered}; "
            "archive/remove that worktree before creating isolated per-run worktrees"
        )


def _integration_start_sha(config: AutoDevConfig, branch: str, base_sha: str) -> str:
    repo_root = config.project.repo_root
    if not _branch_exists(repo_root, branch):
        created = run_git(
            repo_root,
            "update-ref",
            f"refs/heads/{branch}",
            base_sha,
            "0" * 40,
        )
        if not created.ok:
            # Two parallel workers may both observe the branch as absent. The
            # update-ref create is the atomic winner; the loser must re-read
            # the winner instead of treating the benign race as task failure.
            if not _branch_exists(repo_root, branch):
                raise AutoDevGitError(
                    created.stderr.strip() or f"cannot create integration branch {branch}"
                )
        else:
            return base_sha
    integration_sha = _require_git(repo_root, "rev-parse", branch).stdout.strip()
    if run_git(repo_root, "merge-base", "--is-ancestor", base_sha, integration_sha).returncode == 0:
        return integration_sha
    if run_git(repo_root, "merge-base", "--is-ancestor", integration_sha, base_sha).returncode == 0:
        update = run_git(
            repo_root,
            "update-ref",
            f"refs/heads/{branch}",
            base_sha,
            integration_sha,
        )
        if not update.ok:
            raise AutoDevGitError(update.stderr.strip() or "cannot fast-forward integration branch")
        return base_sha
    raise AutoDevGitError(
        f"integration branch {branch} has diverged from base_ref; resolve it before rerunning"
    )


def _prove_isolated_worktree(config: AutoDevConfig, path: Path, branch: str) -> Path:
    repo_root = config.project.repo_root
    main_top = Path(_require_git(repo_root, "rev-parse", "--show-toplevel").stdout.strip()).resolve()
    worktree_top = Path(_require_git(path, "rev-parse", "--show-toplevel").stdout.strip()).resolve()
    dedicated_root = config.branch.worktree.root.resolve(strict=False)
    if dedicated_root == main_top or dedicated_root.is_relative_to(main_top):
        raise AutoDevGitError(
            "branch.worktree.root must be a dedicated directory outside the main repository"
        )
    if worktree_top == main_top:
        raise AutoDevGitError(f"worktree isolation proof failed: workspace resolves to main repository {main_top}")
    try:
        worktree_top.relative_to(dedicated_root)
    except ValueError as exc:
        raise AutoDevGitError(
            f"worktree isolation proof failed: {worktree_top} is outside dedicated root {dedicated_root}"
        ) from exc

    registered = _worktree_for_branch(repo_root, branch)
    if registered is None or registered.resolve(strict=False) != worktree_top:
        raise AutoDevGitError(
            f"git worktree list does not prove {branch} belongs to isolated workspace {worktree_top}"
        )
    return worktree_top


def _sync_worktree_to_base(worktree: Path, branch: str, base_sha: str) -> None:
    """Bring a reused integration worktree up to date with a moved base_ref.

    A same-day rerun reuses the existing worktree; if base_ref advanced in the
    meantime the builder would silently work on stale code (E-203). The branch
    being ahead of base (task commits from earlier runs) is the normal case and
    needs no action. The fast-forward runs inside the worktree because the
    branch is checked out there and cannot be moved from the main repository.
    """
    head_sha = _require_git(worktree, "rev-parse", "HEAD").stdout.strip()
    if head_sha == base_sha:
        return
    if run_git(worktree, "merge-base", "--is-ancestor", base_sha, "HEAD").returncode == 0:
        return
    if run_git(worktree, "merge-base", "--is-ancestor", "HEAD", base_sha).returncode != 0:
        raise AutoDevGitError(
            f"integration branch {branch} has diverged from base_ref "
            f"(worktree HEAD {head_sha[:12]}, base {base_sha[:12]}); resolve manually before rerunning"
        )
    if _require_git(worktree, "status", "--porcelain").stdout.strip():
        raise AutoDevGitError(
            f"integration worktree {worktree} is behind base_ref but has uncommitted changes; "
            "commit or clean it before rerunning"
        )
    result = run_git(worktree, "merge", "--ff-only", base_sha, timeout_seconds=180)
    if not result.ok:
        raise AutoDevGitError(
            result.stderr.strip() or result.stdout.strip() or f"fast-forward of {branch} to base_ref failed"
        )


def _resolve_executable(command: str, cwd: Path) -> str:
    if "/" in command:
        path = Path(command)
        if not path.is_absolute():
            path = cwd / path
        if path.exists() and path.is_file():
            return str(path)
        return ""
    return shutil.which(command) or ""


def _ensure_verify_executables(config: AutoDevConfig, cwd: Path) -> None:
    missing: list[str] = []
    for command in config.verify.default:
        parts = shlex.split(command)
        if not parts:
            missing.append("empty verify command")
        elif not _resolve_executable(parts[0], cwd):
            missing.append(parts[0])
    if missing:
        raise AutoDevGitError(f"verify command not executable in worktree: {', '.join(missing)}")


def _run_setup_command(command: str, cwd: Path) -> None:
    proc = subprocess.run(
        shlex.split(command),
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        raise AutoDevGitError(proc.stderr.strip() or proc.stdout.strip() or f"setup command failed: {command}")


def _setup_worktree(config: AutoDevConfig, path: Path) -> None:
    setup = config.branch.worktree.setup
    if setup.mode == "symlink_venv":
        source = config.project.repo_root / setup.source
        target = path / (setup.target or setup.source)
        if not source.exists():
            raise AutoDevGitError(f"worktree setup source not found: {source}")
        if target.exists() or target.is_symlink():
            if target.is_symlink() and target.resolve(strict=False) == source.resolve(strict=False):
                pass
            else:
                raise AutoDevGitError(f"worktree setup target already exists: {target}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(source, target_is_directory=source.is_dir())
    elif setup.mode != "none":
        raise AutoDevGitError(f"unsupported worktree setup mode: {setup.mode}")

    for command in setup.commands:
        _run_setup_command(command, path)


def prepare_worktree(config: AutoDevConfig, run_id: str) -> WorktreeContext:
    run_id = validate_run_id(run_id)
    repo_root = config.project.repo_root
    base_ref = config.branch.base_ref
    base_sha = _require_git(repo_root, "rev-parse", "--verify", base_ref).stdout.strip()
    if not config.branch.worktree.enabled:
        if config.policy.require_worktree_isolation:
            raise AutoDevGitError("policy.require_worktree_isolation is true but branch.worktree.enabled is false")
        branch = _require_git(repo_root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        return WorktreeContext(path=repo_root, branch=branch, base_ref=base_ref, base_sha=base_sha, isolated=False)

    integration = integration_branch(config)
    _validate_integration_branch(config, integration)
    start_sha = _integration_start_sha(config, integration, base_sha)
    branch = run_branch(config, run_id)
    path = _ensure_worktree(config, run_id, branch, start_sha)
    path = _prove_isolated_worktree(config, path, branch)
    _setup_worktree(config, path)
    _ensure_verify_executables(config, path)
    return WorktreeContext(
        path=path,
        branch=branch,
        base_ref=base_ref,
        base_sha=base_sha,
        isolated=True,
        integration_branch=integration,
        integration_base_sha=start_sha,
    )


def _unstage_uncommittable_paths(workspace: WorktreeContext) -> list[str]:
    """Drop paths that must never enter a task commit from the index.

    Runtime run/notification artifacts are never product changes. Two other
    escape hatches leak machine-local artifacts into the index: (1) an
    earlier ``git add -N`` (used to surface untracked files in the review diff)
    marks intent-to-add on files that ``.gitignore`` fails to cover, and (2) the
    ``.venv/`` pattern (trailing slash = directory only) does not match the
    ``.venv`` *symlink* the worktree setup creates. Either way an absolute-path
    symlink pointing outside the worktree would be committed and later clobber
    the real venv on checkout. Unstage anything gitignored or symlinked outside.
    """
    # Only inspect newly-added entries; modified/deleted tracked files must be
    # committed as-is even if a stray pattern would match them.
    staged = run_git(workspace.path, "diff", "--cached", "--name-status", "-z")
    if not staged.ok:
        return []
    fields = [field for field in staged.stdout.split("\0") if field]
    added: list[str] = []
    index = 0
    while index < len(fields):
        status = fields[index]
        if status.startswith("A") and index + 1 < len(fields):
            added.append(fields[index + 1])
        index += 2 if not status.startswith("R") else 3
    worktree_root = workspace.path.resolve(strict=False)
    to_unstage: list[str] = []
    for name in added:
        normalized = name.replace("\\", "/")
        if (
            normalized.startswith(".autodev/runs/")
            or normalized.startswith(".autodev/runtime/")
            or normalized == ".autodev/latest_handoff.md"
            or normalized.startswith("outputs/autodev/")
        ):
            to_unstage.append(name)
            continue
        full = workspace.path / name
        if full.is_symlink():
            try:
                full.resolve(strict=False).relative_to(worktree_root)
            except ValueError:
                to_unstage.append(name)
                continue
        # ``--no-index`` evaluates the path against .gitignore patterns even
        # though the intent-to-add entry now counts as tracked, which plain
        # ``check-ignore`` would skip.
        ignored = run_git(workspace.path, "check-ignore", "--no-index", "--", name)
        if ignored.ok and ignored.stdout.strip():
            to_unstage.append(name)
    if to_unstage:
        _require_git(workspace.path, "reset", "-q", "--", *to_unstage)
    return to_unstage


def commit_candidate_checkpoint(
    config: AutoDevConfig,
    workspace: WorktreeContext,
    task: dict[str, Any],
    verify: VerifyGateResult,
) -> str:
    if not config.branch.commit_per_task:
        return ""
    _require_git(workspace.path, "add", "-A")
    _unstage_uncommittable_paths(workspace)
    staged = _require_git(workspace.path, "diff", "--cached", "--name-only").stdout.strip()
    if staged:
        title = str(task.get("title") or "").strip()
        task_id = str(task.get("id") or "").strip()
        verify_status = verify.status
        subject = f"[autodev] {task_id}: {title}".strip()
        body = f"Verify: {verify_status}\nBranch: {workspace.branch}"
        _require_git(workspace.path, "commit", "-m", subject, "-m", body, timeout_seconds=180)
    commit = _require_git(workspace.path, "rev-parse", "HEAD").stdout.strip()
    if not staged and commit == workspace.integration_base_sha:
        return ""
    return commit


def advance_integration_ref(
    config: AutoDevConfig,
    workspace: WorktreeContext,
    commit: str,
    *,
    expected_old: str | None = None,
    push: bool = True,
) -> None:
    if not commit:
        return
    # A builder is instructed not to commit, but the safety boundary must not
    # depend on prompt compliance.  If it did commit, the reviewed candidate
    # diff already covered integration_base_sha..HEAD; advance the integration
    # ref with the same CAS instead of silently orphaning the reviewed changes.
    if workspace.integration_branch:
        expected = expected_old or workspace.integration_base_sha
        updated = run_git(
            config.project.repo_root,
            "update-ref",
            f"refs/heads/{workspace.integration_branch}",
            commit,
            expected,
        )
        if not updated.ok:
            raise AutoDevGitError(
                updated.stderr.strip()
                or updated.stdout.strip()
                or (
                    f"integration branch {workspace.integration_branch} changed since worktree creation; "
                    "refusing a non-CAS finalize"
                )
            )
    if push and config.branch.push:
        push_branch = workspace.integration_branch or workspace.branch
        _require_git(
            config.project.repo_root,
            "push",
            "-u",
            "origin",
            push_branch,
            timeout_seconds=300,
        )


def commit_checkpoint(
    config: AutoDevConfig,
    workspace: WorktreeContext,
    task: dict[str, Any],
    verify: VerifyGateResult,
) -> str:
    commit = commit_candidate_checkpoint(config, workspace, task, verify)
    advance_integration_ref(config, workspace, commit)
    return commit
