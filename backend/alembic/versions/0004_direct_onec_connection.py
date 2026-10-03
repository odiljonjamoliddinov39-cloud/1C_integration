"""Direct (OData) connection to 1C: companies.connection_type, onec_connections, onec_snapshots

Revision ID: 0004
Revises: 0003
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("companies", sa.Column("connection_type", sa.String(length=10), nullable=False, server_default="agent"))
    op.create_table(
        "onec_connections",
        sa.Column("company_id", sa.Integer(), nullable=False),
        sa.Column("url", sa.String(length=500), nullable=False),
        sa.Column("username", sa.String(length=255), nullable=False),
        sa.Column("password_enc", sa.Text(), nullable=False),
        sa.Column("last_ok_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("company_id"),
    )
    op.create_table(
        "onec_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("company_id", sa.Integer(), nullable=False),
        sa.Column("cursor", sa.String(length=64), nullable=False),
        sa.Column("versions", sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_onec_snapshots_company_id"), "onec_snapshots", ["company_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_onec_snapshots_company_id"), table_name="onec_snapshots")
    op.drop_table("onec_snapshots")
    op.drop_table("onec_connections")
    op.drop_column("companies", "connection_type")
