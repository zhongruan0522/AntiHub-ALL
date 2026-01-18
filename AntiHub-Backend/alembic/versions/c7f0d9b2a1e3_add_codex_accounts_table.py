"""add_codex_accounts_table

Revision ID: c7f0d9b2a1e3
Revises: 9c1a9a4b2f3d
Create Date: 2026-01-18

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c7f0d9b2a1e3"
down_revision: Union[str, None] = "9c1a9a4b2f3d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "codex_accounts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("account_name", sa.String(length=255), nullable=False),
        sa.Column("status", sa.Integer(), server_default="1", nullable=False),
        sa.Column("is_shared", sa.Integer(), server_default="0", nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("openai_account_id", sa.String(length=255), nullable=True),
        sa.Column("chatgpt_plan_type", sa.String(length=100), nullable=True),
        sa.Column("token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_refresh_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("credentials", sa.Text(), nullable=False),
        sa.Column("quota_remaining", sa.Float(), nullable=True),
        sa.Column("quota_currency", sa.String(length=16), nullable=True),
        sa.Column("quota_updated_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_index(op.f("ix_codex_accounts_user_id"), "codex_accounts", ["user_id"], unique=False)
    op.create_index(op.f("ix_codex_accounts_email"), "codex_accounts", ["email"], unique=False)
    op.create_index(
        op.f("ix_codex_accounts_openai_account_id"),
        "codex_accounts",
        ["openai_account_id"],
        unique=False,
    )
    op.create_index(op.f("ix_codex_accounts_status"), "codex_accounts", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_codex_accounts_status"), table_name="codex_accounts")
    op.drop_index(op.f("ix_codex_accounts_openai_account_id"), table_name="codex_accounts")
    op.drop_index(op.f("ix_codex_accounts_email"), table_name="codex_accounts")
    op.drop_index(op.f("ix_codex_accounts_user_id"), table_name="codex_accounts")
    op.drop_table("codex_accounts")

