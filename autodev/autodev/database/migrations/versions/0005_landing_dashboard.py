"""Add durable landing recovery records.

Revision ID: 0005_landing_dashboard
Revises: 0004_runtime_capacity
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0005_landing_dashboard"
down_revision = "0004_runtime_capacity"
branch_labels = None
depends_on = None


def _json_type():
    return sa.JSON().with_variant(
        postgresql.JSONB(astext_type=sa.Text()), "postgresql"
    )


def upgrade() -> None:
    op.create_table(
        "autodev_landings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("autodev_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("task_id", sa.String(length=128), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("integration_branch", sa.String(length=255), nullable=False),
        sa.Column("expected_ref", sa.String(length=64), nullable=False),
        sa.Column("candidate_sha", sa.String(length=64), nullable=False),
        sa.Column("queue_claim", _json_type(), nullable=False),
        sa.Column("push_required", sa.Boolean(), nullable=False),
        sa.Column("pushed", sa.Boolean(), nullable=False),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("detail", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "project_id",
            "task_id",
            "run_id",
            name="uq_autodev_landings_project_task_run",
        ),
    )
    op.create_index(
        "ix_autodev_landings_project_state",
        "autodev_landings",
        ["project_id", "state", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_autodev_landings_project_state",
        table_name="autodev_landings",
    )
    op.drop_table("autodev_landings")
