"""Right-base guard: companies.base_error

Revision ID: 0003
Revises: 0002
"""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("companies", sa.Column("base_error", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("companies", "base_error")
