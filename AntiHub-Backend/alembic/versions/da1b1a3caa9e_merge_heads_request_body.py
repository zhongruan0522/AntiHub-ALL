"""merge_heads_request_body

Revision ID: da1b1a3caa9e
Revises: c1d2e3f4a5b6, e3f4a5b6c7d8
Create Date: 2026-02-10 22:56:46.931163

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'da1b1a3caa9e'
down_revision: Union[str, None] = ('c1d2e3f4a5b6', 'e3f4a5b6c7d8')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
