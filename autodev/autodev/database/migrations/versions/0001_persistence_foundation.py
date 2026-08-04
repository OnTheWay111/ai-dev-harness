"""Create AutoDev persistence foundation.

Revision ID: 0001_persistence_foundation
Revises:
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0001_persistence_foundation"
down_revision = None
branch_labels = None
depends_on = None


def _json_type():
    return sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "autodev_projects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_key", sa.String(length=255), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("repo_root", sa.Text(), nullable=False),
        sa.Column("repo_fingerprint", sa.String(length=128), nullable=False),
        sa.Column("config_digest", sa.String(length=64), nullable=True),
        sa.Column("host_id", sa.String(length=255), nullable=False),
        sa.Column("detail", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("project_key", name="uq_autodev_projects_key"),
    )
    op.create_table(
        "autodev_import_batches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False, unique=True),
        sa.Column("source_kind", sa.String(length=64), nullable=False),
        sa.Column("source_uri", sa.Text(), nullable=False),
        sa.Column("source_digest", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("summary", _json_type(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_autodev_import_batches_status",
        "autodev_import_batches",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index("ix_autodev_import_batches_status", table_name="autodev_import_batches")
    op.drop_table("autodev_import_batches")
    op.drop_table("autodev_projects")
