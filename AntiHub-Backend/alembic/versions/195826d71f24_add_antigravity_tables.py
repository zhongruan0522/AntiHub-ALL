"""add_antigravity_tables

Revision ID: 195826d71f24
Revises: f3a4b5c6d7e8
Create Date: 2026-02-15 11:29:10.163132

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "195826d71f24"
down_revision: Union[str, None] = "f3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "antigravity_accounts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("cookie_id", sa.String(length=255), nullable=False),
        sa.Column("account_name", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("project_id_0", sa.String(length=255), nullable=True),
        sa.Column("status", sa.Integer(), server_default="1", nullable=False),
        sa.Column("need_refresh", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("is_restricted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("paid_tier", sa.Boolean(), nullable=True),
        sa.Column("ineligible", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_refresh_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("credentials", sa.Text(), nullable=False),
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
        sa.UniqueConstraint("cookie_id", name="uq_antigravity_accounts_cookie_id"),
    )

    op.create_index(
        op.f("ix_antigravity_accounts_user_id"),
        "antigravity_accounts",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_antigravity_accounts_cookie_id"),
        "antigravity_accounts",
        ["cookie_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_antigravity_accounts_email"),
        "antigravity_accounts",
        ["email"],
        unique=False,
    )
    op.create_index(
        op.f("ix_antigravity_accounts_status"),
        "antigravity_accounts",
        ["status"],
        unique=False,
    )

    op.create_table(
        "antigravity_model_quotas",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("cookie_id", sa.String(length=255), nullable=False),
        sa.Column("model_name", sa.String(length=255), nullable=False),
        sa.Column("quota", sa.Float(), server_default="0", nullable=False),
        sa.Column("reset_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.Integer(), server_default="1", nullable=False),
        sa.Column("last_fetched_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.UniqueConstraint(
            "cookie_id",
            "model_name",
            name="uq_antigravity_model_quotas_cookie_model",
        ),
    )

    op.create_index(
        op.f("ix_antigravity_model_quotas_cookie_id"),
        "antigravity_model_quotas",
        ["cookie_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_antigravity_model_quotas_model_name"),
        "antigravity_model_quotas",
        ["model_name"],
        unique=False,
    )
    op.create_index(
        op.f("ix_antigravity_model_quotas_status"),
        "antigravity_model_quotas",
        ["status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_antigravity_model_quotas_status"), table_name="antigravity_model_quotas")
    op.drop_index(
        op.f("ix_antigravity_model_quotas_model_name"), table_name="antigravity_model_quotas"
    )
    op.drop_index(
        op.f("ix_antigravity_model_quotas_cookie_id"), table_name="antigravity_model_quotas"
    )
    op.drop_table("antigravity_model_quotas")

    op.drop_index(op.f("ix_antigravity_accounts_status"), table_name="antigravity_accounts")
    op.drop_index(op.f("ix_antigravity_accounts_email"), table_name="antigravity_accounts")
    op.drop_index(op.f("ix_antigravity_accounts_cookie_id"), table_name="antigravity_accounts")
    op.drop_index(op.f("ix_antigravity_accounts_user_id"), table_name="antigravity_accounts")
    op.drop_table("antigravity_accounts")
