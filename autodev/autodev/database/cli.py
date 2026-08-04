"""CLI for optional AutoDev PostgreSQL migrations and health."""
from __future__ import annotations

import argparse
import fcntl
import json
from pathlib import Path
import sys

from autodev.persistence import PersistenceConfigurationError

from .config import DatabaseConfigError, load_database_config


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage AutoDev database persistence")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("upgrade")
    sub.add_parser("current")
    sub.add_parser("head")
    sub.add_parser("check")
    sub.add_parser(
        "cutover-status",
        help="Show the host-local database receipt and authorized projects",
    )
    down = sub.add_parser("downgrade")
    down.add_argument("revision")
    down.add_argument(
        "--yes",
        action="store_true",
        help="Confirm the destructive schema downgrade",
    )
    for name in ("import-runs", "reconcile-runs"):
        command = sub.add_parser(name)
        command.add_argument("--repo-root", required=True)
        command.add_argument("--project-id", required=True)
    for name in ("import-queue", "reconcile-queue"):
        command = sub.add_parser(name)
        command.add_argument("--repo-root", required=True)
        command.add_argument("--project-id", required=True)
        command.add_argument("--queue-path", required=True)
    for name in ("shadow-sync", "prepare-cutover", "activate-cutover"):
        command = sub.add_parser(name)
        command.add_argument("--repo-root", required=True)
        command.add_argument("--project-id", required=True)
        command.add_argument("--queue-path", required=True)
        command.add_argument(
            "--stop-file",
            default=".autodev/STOP",
            help="Repo-relative write-freeze marker",
        )
        if name == "activate-cutover":
            command.add_argument("--confirm-digest", required=True)
    parser.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "cutover-status":
        try:
            from .cutover import load_cutover_receipt, receipt_project_entries

            receipt = load_cutover_receipt()
            entries = receipt_project_entries(receipt) if receipt else ()
            payload = {
                "ok": True,
                "state": str(receipt.get("state")) if receipt else "inactive",
                "schema_version": (
                    int(receipt.get("schema_version")) if receipt else None
                ),
                "database_url_fingerprint": (
                    str(receipt.get("database_url_fingerprint")) if receipt else ""
                ),
                "projects": [
                    {
                        "project_id": entry["project_id"],
                        "repo_root": entry["repo_root"],
                        "activated_at": entry["activated_at"],
                        "cutover_digest": entry["cutover_digest"],
                    }
                    for entry in entries
                ],
            }
            if args.json:
                print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
            else:
                print(payload)
            return 0
        except PersistenceConfigurationError as exc:
            print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        except Exception as exc:
            print(f"{type(exc).__name__}: database command failed", file=sys.stderr)
            return 1
    try:
        config = load_database_config(
            allow_unactivated_database=args.command == "activate-cutover"
        )
        if not config.uses_database:
            raise RuntimeError("database command requires shadow/database mode")
        from .engine import Database
        from .health import check_database_health
        from .migration import current_revision, downgrade, head_revision, upgrade

        if args.command == "upgrade":
            upgrade(database_config=config)
            payload = {"ok": True, "revision": head_revision()}
        elif args.command == "downgrade":
            if not args.yes:
                raise RuntimeError("downgrade is destructive; pass --yes to confirm")
            downgrade(args.revision, database_config=config)
            payload = {"ok": True, "revision": args.revision}
        elif args.command == "head":
            payload = {"ok": True, "revision": head_revision()}
        elif args.command in {"current", "check"}:
            database = Database.from_config(config)
            try:
                if args.command == "current":
                    payload = {"ok": True, "revision": current_revision(database)}
                else:
                    payload = check_database_health(database, config).to_dict()
            finally:
                database.dispose()
        elif args.command in {"import-runs", "reconcile-runs"}:
            from .run_importer import RunFileImporter
            from .run_repository import DatabaseRunStore, ProjectIdentity

            repo_root = Path(args.repo_root).expanduser().resolve(strict=True)
            database = Database.from_config(config)
            try:
                store = DatabaseRunStore(
                    database,
                    ProjectIdentity.local(args.project_id, repo_root),
                )
                importer = RunFileImporter(store, repo_root)
                if args.command == "import-runs":
                    payload = {"ok": True, **importer.import_all().to_dict()}
                else:
                    payload = importer.reconcile()
            finally:
                database.dispose()
        elif args.command in {"import-queue", "reconcile-queue"}:
            from .queue_repository import DatabaseQueueRepository
            from .run_repository import ProjectIdentity

            repo_root = Path(args.repo_root).expanduser().resolve(strict=True)
            queue_path = Path(args.queue_path).expanduser().resolve(strict=True)
            database = Database.from_config(config)
            try:
                repository = DatabaseQueueRepository(
                    database,
                    ProjectIdentity.local(args.project_id, repo_root),
                )
                if args.command == "import-queue":
                    payload = {
                        "ok": True,
                        **repository.import_file(queue_path),
                    }
                else:
                    payload = repository.reconcile_file(queue_path)
            finally:
                database.dispose()
        else:
            from .cutover import activate_cutover, cutover_digest
            from .engine import Database
            from .queue_repository import DatabaseQueueRepository
            from .run_importer import RunFileImporter
            from .run_repository import (
                DatabaseRunStore,
                ProjectIdentity,
                canonical_digest,
            )

            repo_root = Path(args.repo_root).expanduser().resolve(strict=True)
            queue_path = Path(args.queue_path).expanduser().resolve(strict=True)
            stop_file = (repo_root / args.stop_file).resolve(strict=False)
            try:
                stop_file.relative_to(repo_root)
            except ValueError as exc:
                raise RuntimeError("stop-file must stay inside repo-root") from exc
            database = Database.from_config(config)
            try:
                identity = ProjectIdentity.local(args.project_id, repo_root)
                importer = RunFileImporter(
                    DatabaseRunStore(database, identity), repo_root
                )
                queue = DatabaseQueueRepository(database, identity)
                run_import = importer.import_all().to_dict()
                queue_import = queue.import_file(queue_path)
                if args.command == "shadow-sync":
                    run_reconcile = importer.reconcile()
                    queue_reconcile = queue.reconcile_file(queue_path)
                    payload = {
                        "ok": bool(
                            run_reconcile.get("ok")
                            and queue_reconcile.get("ok")
                        ),
                        "run_import": run_import,
                        "queue_import": queue_import,
                        "run_reconcile": run_reconcile,
                        "queue_reconcile": queue_reconcile,
                    }
                else:
                    if not stop_file.is_file():
                        raise RuntimeError(
                            f"write freeze marker is missing: {stop_file}"
                        )
                    from autodev.host_capacity import load_host_policy
                    from autodev.runtime_lease import (
                        lease_is_live,
                        project_loop_lock_path,
                        read_project_loop_lease,
                    )

                    from .landing_repository import DatabaseLandingStore
                    from .runtime_repository import DatabaseRuntimeCapacity
                    from .cutover import load_cutover_receipt

                    loop_lock_path = project_loop_lock_path(repo_root)
                    loop_lock_path.parent.mkdir(parents=True, exist_ok=True)
                    loop_handle = loop_lock_path.open("a+", encoding="utf-8")
                    try:
                        try:
                            fcntl.flock(
                                loop_handle.fileno(),
                                fcntl.LOCK_EX | fcntl.LOCK_NB,
                            )
                        except BlockingIOError as exc:
                            raise RuntimeError(
                                "cutover requires the file-mode project loop "
                                "lock to be released"
                            ) from exc
                    finally:
                        try:
                            fcntl.flock(loop_handle.fileno(), fcntl.LOCK_UN)
                        finally:
                            loop_handle.close()
                    if lease_is_live(
                        read_project_loop_lease(repo_root),
                        repo_root=repo_root,
                    ):
                        raise RuntimeError(
                            "cutover requires the file-mode project loop to stop"
                        )
                    run_lease_root = (
                        repo_root / ".autodev" / "runtime" / "runs"
                    )
                    for run_lease_path in sorted(run_lease_root.glob("*.json")):
                        run_lease = json.loads(
                            run_lease_path.read_text(encoding="utf-8")
                        )
                        run_id = run_lease_path.stem
                        if isinstance(run_lease, dict) and lease_is_live(
                            run_lease,
                            repo_root=repo_root,
                            run_id=run_id,
                        ):
                            raise RuntimeError(
                                "cutover requires all file-mode run "
                                f"heartbeats to stop: {run_id}"
                            )
                    policy = load_host_policy()
                    runtime = DatabaseRuntimeCapacity(
                        database,
                        max_active_workers=(
                            policy.max_active_workers if policy else 1
                        ),
                        provider_limits=(
                            policy.provider_limits if policy else {}
                        ),
                    ).snapshot()
                    active_receipt = load_cutover_receipt()
                    if active_receipt is None:
                        blocking_leases = list(runtime.get("leases") or [])
                        blocking_waiters = list(runtime.get("waiters") or [])
                        runtime_scope = "host"
                    else:
                        # A not-yet-authorized project cannot obtain a DB
                        # runtime lease through normal composition; its actual
                        # onboarding freeze is enforced by the repo-local loop
                        # lock and run heartbeat checks above. This project
                        # filter additionally blocks stale/manual DB state and
                        # safe replays without stopping unrelated authorized
                        # projects that are still running.
                        blocking_leases = [
                            item
                            for item in runtime.get("leases") or []
                            if item.get("project_id") == args.project_id
                        ]
                        blocking_waiters = [
                            item
                            for item in runtime.get("waiters") or []
                            if item.get("project_id") == args.project_id
                        ]
                        runtime_scope = "selected project"
                    if blocking_leases or blocking_waiters:
                        raise RuntimeError(
                            "cutover requires zero live/stale runtime leases "
                            f"and capacity waiters for the {runtime_scope}"
                        )
                    pending_landings = DatabaseLandingStore(
                        database, identity
                    ).pending(args.project_id)
                    if pending_landings:
                        raise RuntimeError(
                            "cutover requires all database landings to be finalized"
                        )
                    landing_root = (
                        repo_root / ".autodev" / "runtime" / "landings"
                    )
                    for landing_path in sorted(landing_root.glob("*.json")):
                        landing = json.loads(
                            landing_path.read_text(encoding="utf-8")
                        )
                        if (
                            not isinstance(landing, dict)
                            or landing.get("schema_version") != 1
                            or landing.get("state") != "queue_finalized"
                        ):
                            raise RuntimeError(
                                "cutover requires all file landings to be "
                                f"valid and finalized: {landing_path}"
                            )
                    queue_sync = queue.synchronize_file(queue_path)
                    run_reconcile = importer.reconcile()
                    queue_reconcile = queue.reconcile_full_file(queue_path)
                    if not run_reconcile.get("ok") or not queue_reconcile.get("ok"):
                        raise RuntimeError(
                            "cutover reconciliation failed after frozen synchronization"
                        )
                    evidence = {
                        "project_id": args.project_id,
                        "repo_root": str(repo_root),
                        "queue_path": str(queue_path),
                        "stop_file": str(stop_file),
                        "run_source_digest": run_import["source_digest"],
                        "run_reconcile_digest": canonical_digest(run_reconcile),
                        "runs_seen": run_import["runs_seen"],
                        "queue_file_digest": queue_reconcile["file_digest"],
                        "queue_database_digest": queue_reconcile[
                            "database_digest"
                        ],
                        "queue_tasks_seen": queue_reconcile["tasks_seen"],
                        "migration_revision": current_revision(database),
                    }
                    digest = cutover_digest(evidence)
                    payload = {
                        "ok": True,
                        "cutover_digest": digest,
                        "evidence": evidence,
                        "queue_sync": queue_sync,
                    }
                    if args.command == "activate-cutover":
                        if config.mode != "database":
                            raise RuntimeError(
                                "activation requires explicit database mode"
                            )
                        receipt = activate_cutover(
                            evidence,
                            expected_digest=args.confirm_digest,
                            database_url=config.require_url(),
                        )
                        payload["receipt"] = receipt
            finally:
                database.dispose()
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        else:
            print(payload)
        return 0 if payload.get("ok") else 1
    except (DatabaseConfigError, RuntimeError) as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"{type(exc).__name__}: database command failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
