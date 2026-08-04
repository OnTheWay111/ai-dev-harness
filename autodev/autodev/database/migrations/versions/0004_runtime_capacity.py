"""Add host runtime lease and capacity request persistence.

Revision ID: 0004_runtime_capacity
Revises: 0003_queue_repository
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0004_runtime_capacity"
down_revision = "0003_queue_repository"
branch_labels = None
depends_on = None


def _json_type():
    return sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "autodev_host_runtime_states",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("host_id", sa.String(length=255), nullable=False),
        sa.Column("max_active_workers", sa.Integer(), nullable=False),
        sa.Column("provider_limits", _json_type(), nullable=False),
        sa.Column("fence_counters", _json_type(), nullable=False),
        sa.Column("last_granted_project", sa.String(length=255), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("host_id", name="uq_autodev_host_runtime_states_host"),
    )
    op.create_table(
        "autodev_runtime_leases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "host_state_id",
            sa.Integer(),
            sa.ForeignKey("autodev_host_runtime_states.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("lease_key", sa.String(length=512), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("project_key", sa.String(length=255), nullable=False),
        sa.Column("worker_id", sa.String(length=255), nullable=True),
        sa.Column("run_id", sa.String(length=128), nullable=True),
        sa.Column("provider", sa.String(length=128), nullable=True),
        sa.Column("resources", _json_type(), nullable=False),
        sa.Column("token_digest", sa.String(length=64), nullable=False),
        sa.Column("fencing_token", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("pid", sa.Integer(), nullable=False),
        sa.Column("process_start_identity", sa.Text(), nullable=False),
        sa.Column("supervisor_pid", sa.Integer(), nullable=True),
        sa.Column("supervisor_start_identity", sa.Text(), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("detail", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "token_digest", name="uq_autodev_runtime_leases_token"
        ),
    )
    op.create_index(
        "ix_autodev_runtime_leases_host_status",
        "autodev_runtime_leases",
        ["host_state_id", "status", "kind"],
    )
    op.create_index(
        "ix_autodev_runtime_leases_project_run",
        "autodev_runtime_leases",
        ["project_key", "run_id"],
    )
    op.create_table(
        "autodev_capacity_requests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "host_state_id",
            sa.Integer(),
            sa.ForeignKey("autodev_host_runtime_states.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("request_id", sa.String(length=128), nullable=False),
        sa.Column("lease_key", sa.String(length=512), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("project_key", sa.String(length=255), nullable=False),
        sa.Column("worker_id", sa.String(length=255), nullable=True),
        sa.Column("run_id", sa.String(length=128), nullable=True),
        sa.Column("provider", sa.String(length=128), nullable=True),
        sa.Column("resources", _json_type(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("pid", sa.Integer(), nullable=False),
        sa.Column("process_start_identity", sa.Text(), nullable=False),
        sa.Column("supervisor_pid", sa.Integer(), nullable=True),
        sa.Column("supervisor_start_identity", sa.Text(), nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("detail", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "request_id", name="uq_autodev_capacity_requests_id"
        ),
    )
    op.create_index(
        "ix_autodev_capacity_requests_host_status",
        "autodev_capacity_requests",
        ["host_state_id", "status", "requested_at"],
    )
    op.create_index(
        "ix_autodev_capacity_requests_project_fifo",
        "autodev_capacity_requests",
        ["host_state_id", "project_key", "requested_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_autodev_capacity_requests_project_fifo",
        table_name="autodev_capacity_requests",
    )
    op.drop_index(
        "ix_autodev_capacity_requests_host_status",
        table_name="autodev_capacity_requests",
    )
    op.drop_table("autodev_capacity_requests")
    op.drop_index(
        "ix_autodev_runtime_leases_project_run",
        table_name="autodev_runtime_leases",
    )
    op.drop_index(
        "ix_autodev_runtime_leases_host_status",
        table_name="autodev_runtime_leases",
    )
    op.drop_table("autodev_runtime_leases")
    op.drop_table("autodev_host_runtime_states")
