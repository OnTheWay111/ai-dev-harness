"""Add Run, Run Event, and Artifact index persistence.

Revision ID: 0002_run_event_artifact
Revises: 0001_persistence_foundation
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0002_run_event_artifact"
down_revision = "0001_persistence_foundation"
branch_labels = None
depends_on = None


def _json_type():
    return sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "autodev_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("autodev_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("parent_run_id", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("snapshot", _json_type(), nullable=False),
        sa.Column("snapshot_digest", sa.String(length=64), nullable=False),
        sa.Column("source_uri", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "project_id", "run_id", name="uq_autodev_runs_project_run"
        ),
    )
    op.create_index(
        "ix_autodev_runs_project_updated",
        "autodev_runs",
        ["project_id", "updated_at"],
    )
    op.create_table(
        "autodev_run_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "run_pk",
            sa.Integer(),
            sa.ForeignKey("autodev_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("timestamp", sa.String(length=64), nullable=False),
        sa.Column("level", sa.String(length=32), nullable=False),
        sa.Column("phase", sa.String(length=64), nullable=False),
        sa.Column("task_id", sa.String(length=128), nullable=True),
        sa.Column("event_digest", sa.String(length=64), nullable=False),
        sa.Column("payload", _json_type(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("run_pk", "seq", name="uq_autodev_run_events_run_seq"),
    )
    op.create_index(
        "ix_autodev_run_events_run_timestamp",
        "autodev_run_events",
        ["run_pk", "timestamp"],
    )
    op.create_table(
        "autodev_artifacts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "run_pk",
            sa.Integer(),
            sa.ForeignKey("autodev_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("task_id", sa.String(length=128), nullable=True),
        sa.Column("logical_name", sa.String(length=255), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("uri", sa.Text(), nullable=False),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("run_pk", "uri", name="uq_autodev_artifacts_run_uri"),
    )
    op.create_index(
        "ix_autodev_artifacts_run_task",
        "autodev_artifacts",
        ["run_pk", "task_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_autodev_artifacts_run_task", table_name="autodev_artifacts")
    op.drop_table("autodev_artifacts")
    op.drop_index("ix_autodev_run_events_run_timestamp", table_name="autodev_run_events")
    op.drop_table("autodev_run_events")
    op.drop_index("ix_autodev_runs_project_updated", table_name="autodev_runs")
    op.drop_table("autodev_runs")
