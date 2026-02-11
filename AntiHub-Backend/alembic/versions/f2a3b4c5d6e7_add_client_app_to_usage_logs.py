"""add_client_app_to_usage_logs

Revision ID: f2a3b4c5d6e7
Revises: da1b1a3caa9e
Create Date: 2026-02-11

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f2a3b4c5d6e7"
down_revision: Union[str, Sequence[str], None] = "da1b1a3caa9e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "usage_logs",
        sa.Column("client_app", sa.String(length=128), nullable=True),
    )
    op.create_index(
        op.f("ix_usage_logs_client_app"),
        "usage_logs",
        ["client_app"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_usage_logs_client_app"), table_name="usage_logs")
    op.drop_column("usage_logs", "client_app")

