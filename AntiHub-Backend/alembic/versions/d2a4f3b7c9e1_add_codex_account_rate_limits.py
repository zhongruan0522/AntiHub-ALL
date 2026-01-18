"""add_codex_account_rate_limits

Revision ID: d2a4f3b7c9e1
Revises: c7f0d9b2a1e3
Create Date: 2026-01-18

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d2a4f3b7c9e1"
down_revision: Union[str, None] = "c7f0d9b2a1e3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("codex_accounts", sa.Column("limit_5h_used_percent", sa.Integer(), nullable=True))
    op.add_column("codex_accounts", sa.Column("limit_5h_reset_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("codex_accounts", sa.Column("limit_week_used_percent", sa.Integer(), nullable=True))
    op.add_column("codex_accounts", sa.Column("limit_week_reset_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("codex_accounts", "limit_week_reset_at")
    op.drop_column("codex_accounts", "limit_week_used_percent")
    op.drop_column("codex_accounts", "limit_5h_reset_at")
    op.drop_column("codex_accounts", "limit_5h_used_percent")

