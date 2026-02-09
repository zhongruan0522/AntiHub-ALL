"""add_usage_counters_table

Revision ID: c1d2e3f4a5b6
Revises: d4e5f6a7b8c9
Create Date: 2026-02-09

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c1d2e3f4a5b6"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "usage_counters",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("config_type", sa.String(length=20), nullable=False),
        sa.Column("total_requests", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("success_requests", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("failed_requests", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("input_tokens", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("output_tokens", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("cached_tokens", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("total_tokens", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("total_quota_consumed", sa.Float(), server_default="0", nullable=False),
        sa.Column("total_duration_ms", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("user_id", "config_type", name="uq_usage_counters_user_config_type"),
    )

    op.create_index(op.f("ix_usage_counters_user_id"), "usage_counters", ["user_id"], unique=False)
    op.create_index(op.f("ix_usage_counters_config_type"), "usage_counters", ["config_type"], unique=False)

    # Backfill：把当前 usage_logs（最近 N 条滑动窗口）聚合进 counters，保证升级后展示不突变
    op.execute(
        """
        INSERT INTO usage_counters (
            user_id,
            config_type,
            total_requests,
            success_requests,
            failed_requests,
            input_tokens,
            output_tokens,
            cached_tokens,
            total_tokens,
            total_quota_consumed,
            total_duration_ms
        )
        SELECT
            user_id,
            COALESCE(config_type, 'unknown') AS config_type,
            COUNT(id) AS total_requests,
            SUM(CASE WHEN success THEN 1 ELSE 0 END) AS success_requests,
            SUM(CASE WHEN success THEN 0 ELSE 1 END) AS failed_requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            0 AS cached_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(quota_consumed), 0) AS total_quota_consumed,
            COALESCE(SUM(duration_ms), 0) AS total_duration_ms
        FROM usage_logs
        GROUP BY user_id, COALESCE(config_type, 'unknown')
        """
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_usage_counters_config_type"), table_name="usage_counters")
    op.drop_index(op.f("ix_usage_counters_user_id"), table_name="usage_counters")
    op.drop_table("usage_counters")

