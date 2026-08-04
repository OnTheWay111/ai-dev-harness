"""Add queue manifest, task runtime, and task event persistence.

Revision ID: 0003_queue_repository
Revises: 0002_run_event_artifact
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0003_queue_repository"
down_revision = "0002_run_event_artifact"
branch_labels = None
depends_on = None


def _json_type():
    return sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "autodev_queue_manifests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("autodev_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("max_in_progress", sa.Integer(), nullable=False),
        sa.Column("manifest_digest", sa.String(length=64), nullable=False),
        sa.Column("source_uri", sa.Text(), nullable=True),
        sa.Column("policy", _json_type(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "project_id", name="uq_autodev_queue_manifests_project"
        ),
    )
    op.create_table(
        "autodev_queue_tasks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("autodev_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("task_id", sa.String(length=128), nullable=False),
        sa.Column("origin", sa.String(length=32), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("priority_rank", sa.Integer(), nullable=False),
        sa.Column("spec", _json_type(), nullable=False),
        sa.Column("spec_digest", sa.String(length=64), nullable=False),
        sa.Column("runtime", _json_type(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("owner", sa.String(length=255), nullable=True),
        sa.Column("lease_token", sa.String(length=255), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("fencing_token", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "project_id",
            "task_id",
            name="uq_autodev_queue_tasks_project_task",
        ),
    )
    op.create_index(
        "ix_autodev_queue_tasks_project_status",
        "autodev_queue_tasks",
        ["project_id", "status", "priority_rank", "task_id"],
    )
    op.create_table(
        "autodev_queue_task_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "task_pk",
            sa.Integer(),
            sa.ForeignKey("autodev_queue_tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("event_digest", sa.String(length=64), nullable=False),
        sa.Column("payload", _json_type(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "task_pk", "seq", name="uq_autodev_queue_task_events_task_seq"
        ),
    )
    op.create_index(
        "ix_autodev_queue_task_events_task_created",
        "autodev_queue_task_events",
        ["task_pk", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_autodev_queue_task_events_task_created",
        table_name="autodev_queue_task_events",
    )
    op.drop_table("autodev_queue_task_events")
    op.drop_index(
        "ix_autodev_queue_tasks_project_status",
        table_name="autodev_queue_tasks",
    )
    op.drop_table("autodev_queue_tasks")
    op.drop_table("autodev_queue_manifests")
