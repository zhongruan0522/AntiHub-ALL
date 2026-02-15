"""add_plugin_user_mappings_table

Revision ID: 2b6c1a1f7c3e
Revises: 195826d71f24
Create Date: 2026-02-15 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "2b6c1a1f7c3e"
down_revision: Union[str, None] = "195826d71f24"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "plugin_user_mappings",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("plugin_user_id", sa.String(length=64), nullable=False),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "plugin_user_id",
            name="uq_plugin_user_mappings_plugin_user_id",
        ),
    )

    op.create_index(
        op.f("ix_plugin_user_mappings_plugin_user_id"),
        "plugin_user_mappings",
        ["plugin_user_id"],
        unique=True,
    )
    op.create_index(
        op.f("ix_plugin_user_mappings_user_id"),
        "plugin_user_mappings",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_plugin_user_mappings_user_id"), table_name="plugin_user_mappings")
    op.drop_index(op.f("ix_plugin_user_mappings_plugin_user_id"), table_name="plugin_user_mappings")
    op.drop_table("plugin_user_mappings")

