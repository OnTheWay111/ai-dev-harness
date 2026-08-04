"""Initial SQLAlchemy models for AutoDev project and import identity."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import ForeignKey, Index, JSON, DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


JSONColumn = JSON().with_variant(JSONB(), "postgresql")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "autodev_projects"
    __table_args__ = (UniqueConstraint("project_key", name="uq_autodev_projects_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_key: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    repo_root: Mapped[str] = mapped_column(Text, nullable=False)
    repo_fingerprint: Mapped[str] = mapped_column(String(128), nullable=False)
    config_digest: Mapped[str | None] = mapped_column(String(64))
    host_id: Mapped[str] = mapped_column(String(255), nullable=False)
    detail: Mapped[dict | None] = mapped_column(JSONColumn)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class ImportBatch(Base):
    __tablename__ = "autodev_import_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    source_kind: Mapped[str] = mapped_column(String(64), nullable=False)
    source_uri: Mapped[str] = mapped_column(Text, nullable=False)
    source_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    summary: Mapped[dict | None] = mapped_column(JSONColumn)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class Run(Base):
    __tablename__ = "autodev_runs"
    __table_args__ = (
        UniqueConstraint("project_id", "run_id", name="uq_autodev_runs_project_run"),
        Index("ix_autodev_runs_project_updated", "project_id", "updated_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("autodev_projects.id", ondelete="CASCADE"), nullable=False
    )
    run_id: Mapped[str] = mapped_column(String(128), nullable=False)
    parent_run_id: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    snapshot: Mapped[dict] = mapped_column(JSONColumn, nullable=False)
    snapshot_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    source_uri: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class RunEvent(Base):
    __tablename__ = "autodev_run_events"
    __table_args__ = (
        UniqueConstraint("run_pk", "seq", name="uq_autodev_run_events_run_seq"),
        Index("ix_autodev_run_events_run_timestamp", "run_pk", "timestamp"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_pk: Mapped[int] = mapped_column(
        ForeignKey("autodev_runs.id", ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    timestamp: Mapped[str] = mapped_column(String(64), nullable=False)
    level: Mapped[str] = mapped_column(String(32), nullable=False)
    phase: Mapped[str] = mapped_column(String(64), nullable=False)
    task_id: Mapped[str | None] = mapped_column(String(128))
    event_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONColumn, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class ArtifactIndex(Base):
    __tablename__ = "autodev_artifacts"
    __table_args__ = (
        UniqueConstraint("run_pk", "uri", name="uq_autodev_artifacts_run_uri"),
        Index("ix_autodev_artifacts_run_task", "run_pk", "task_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_pk: Mapped[int] = mapped_column(
        ForeignKey("autodev_runs.id", ondelete="CASCADE"), nullable=False
    )
    task_id: Mapped[str | None] = mapped_column(String(128))
    logical_name: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    uri: Mapped[str] = mapped_column(Text, nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class QueueManifest(Base):
    __tablename__ = "autodev_queue_manifests"
    __table_args__ = (
        UniqueConstraint("project_id", name="uq_autodev_queue_manifests_project"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("autodev_projects.id", ondelete="CASCADE"), nullable=False
    )
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    max_in_progress: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    manifest_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    source_uri: Mapped[str | None] = mapped_column(Text)
    policy: Mapped[dict] = mapped_column(JSONColumn, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class QueueTask(Base):
    __tablename__ = "autodev_queue_tasks"
    __table_args__ = (
        UniqueConstraint(
            "project_id", "task_id", name="uq_autodev_queue_tasks_project_task"
        ),
        Index(
            "ix_autodev_queue_tasks_project_status",
            "project_id",
            "status",
            "priority_rank",
            "task_id",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("autodev_projects.id", ondelete="CASCADE"), nullable=False
    )
    task_id: Mapped[str] = mapped_column(String(128), nullable=False)
    origin: Mapped[str] = mapped_column(String(32), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    priority_rank: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    spec: Mapped[dict] = mapped_column(JSONColumn, nullable=False)
    spec_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    runtime: Mapped[dict] = mapped_column(JSONColumn, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    owner: Mapped[str | None] = mapped_column(String(255))
    lease_token: Mapped[str | None] = mapped_column(String(255))
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    fencing_token: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class QueueTaskEvent(Base):
    __tablename__ = "autodev_queue_task_events"
    __table_args__ = (
        UniqueConstraint(
            "task_pk", "seq", name="uq_autodev_queue_task_events_task_seq"
        ),
        Index("ix_autodev_queue_task_events_task_created", "task_pk", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_pk: Mapped[int] = mapped_column(
        ForeignKey("autodev_queue_tasks.id", ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    event_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONColumn, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class HostRuntimeState(Base):
    __tablename__ = "autodev_host_runtime_states"
    __table_args__ = (
        UniqueConstraint("host_id", name="uq_autodev_host_runtime_states_host"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    host_id: Mapped[str] = mapped_column(String(255), nullable=False)
    max_active_workers: Mapped[int] = mapped_column(Integer, nullable=False)
    provider_limits: Mapped[dict] = mapped_column(JSONColumn, nullable=False)
    fence_counters: Mapped[dict] = mapped_column(JSONColumn, nullable=False)
    last_granted_project: Mapped[str | None] = mapped_column(String(255))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class RuntimeLease(Base):
    __tablename__ = "autodev_runtime_leases"
    __table_args__ = (
        UniqueConstraint("token_digest", name="uq_autodev_runtime_leases_token"),
        Index(
            "ix_autodev_runtime_leases_host_status",
            "host_state_id",
            "status",
            "kind",
        ),
        Index(
            "ix_autodev_runtime_leases_project_run",
            "project_key",
            "run_id",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    host_state_id: Mapped[int] = mapped_column(
        ForeignKey("autodev_host_runtime_states.id", ondelete="CASCADE"),
        nullable=False,
    )
    lease_key: Mapped[str] = mapped_column(String(512), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    project_key: Mapped[str] = mapped_column(String(255), nullable=False)
    worker_id: Mapped[str | None] = mapped_column(String(255))
    run_id: Mapped[str | None] = mapped_column(String(128))
    provider: Mapped[str | None] = mapped_column(String(128))
    resources: Mapped[list] = mapped_column(JSONColumn, nullable=False)
    token_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    fencing_token: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    pid: Mapped[int] = mapped_column(Integer, nullable=False)
    process_start_identity: Mapped[str] = mapped_column(Text, nullable=False)
    supervisor_pid: Mapped[int | None] = mapped_column(Integer)
    supervisor_start_identity: Mapped[str | None] = mapped_column(Text)
    heartbeat_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    detail: Mapped[dict | None] = mapped_column(JSONColumn)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class CapacityRequest(Base):
    __tablename__ = "autodev_capacity_requests"
    __table_args__ = (
        UniqueConstraint("request_id", name="uq_autodev_capacity_requests_id"),
        Index(
            "ix_autodev_capacity_requests_host_status",
            "host_state_id",
            "status",
            "requested_at",
        ),
        Index(
            "ix_autodev_capacity_requests_project_fifo",
            "host_state_id",
            "project_key",
            "requested_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    host_state_id: Mapped[int] = mapped_column(
        ForeignKey("autodev_host_runtime_states.id", ondelete="CASCADE"),
        nullable=False,
    )
    request_id: Mapped[str] = mapped_column(String(128), nullable=False)
    lease_key: Mapped[str] = mapped_column(String(512), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    project_key: Mapped[str] = mapped_column(String(255), nullable=False)
    worker_id: Mapped[str | None] = mapped_column(String(255))
    run_id: Mapped[str | None] = mapped_column(String(128))
    provider: Mapped[str | None] = mapped_column(String(128))
    resources: Mapped[list] = mapped_column(JSONColumn, nullable=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    pid: Mapped[int] = mapped_column(Integer, nullable=False)
    process_start_identity: Mapped[str] = mapped_column(Text, nullable=False)
    supervisor_pid: Mapped[int | None] = mapped_column(Integer)
    supervisor_start_identity: Mapped[str | None] = mapped_column(Text)
    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    heartbeat_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    detail: Mapped[dict | None] = mapped_column(JSONColumn)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class Landing(Base):
    __tablename__ = "autodev_landings"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "task_id",
            "run_id",
            name="uq_autodev_landings_project_task_run",
        ),
        Index(
            "ix_autodev_landings_project_state",
            "project_id",
            "state",
            "updated_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("autodev_projects.id", ondelete="CASCADE"), nullable=False
    )
    task_id: Mapped[str] = mapped_column(String(128), nullable=False)
    run_id: Mapped[str] = mapped_column(String(128), nullable=False)
    integration_branch: Mapped[str] = mapped_column(String(255), nullable=False)
    expected_ref: Mapped[str] = mapped_column(String(64), nullable=False)
    candidate_sha: Mapped[str] = mapped_column(String(64), nullable=False)
    queue_claim: Mapped[dict] = mapped_column(JSONColumn, nullable=False)
    push_required: Mapped[bool] = mapped_column(nullable=False, default=False)
    pushed: Mapped[bool] = mapped_column(nullable=False, default=False)
    state: Mapped[str] = mapped_column(String(32), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    detail: Mapped[dict | None] = mapped_column(JSONColumn)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


EXPECTED_TABLES = frozenset(
    {
        Project.__tablename__,
        ImportBatch.__tablename__,
        Run.__tablename__,
        RunEvent.__tablename__,
        ArtifactIndex.__tablename__,
        QueueManifest.__tablename__,
        QueueTask.__tablename__,
        QueueTaskEvent.__tablename__,
        HostRuntimeState.__tablename__,
        RuntimeLease.__tablename__,
        CapacityRequest.__tablename__,
        Landing.__tablename__,
    }
)
