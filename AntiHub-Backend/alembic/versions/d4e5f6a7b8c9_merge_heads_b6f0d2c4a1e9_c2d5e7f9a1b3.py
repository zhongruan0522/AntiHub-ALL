"""merge_heads_b6f0d2c4a1e9_c2d5e7f9a1b3

Revision ID: d4e5f6a7b8c9
Revises: b6f0d2c4a1e9, c2d5e7f9a1b3
Create Date: 2026-02-09

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, Sequence[str], None] = ("b6f0d2c4a1e9", "c2d5e7f9a1b3")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

