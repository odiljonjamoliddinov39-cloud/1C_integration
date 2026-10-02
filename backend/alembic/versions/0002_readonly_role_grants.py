"""Read-only role for Ask AI and MCP queries.

The role itself (and its password) is created by deploy/postgres/init-readonly.sh. This migration
grants it SELECT on the mirror tables only: never on users, agents, fixes or event_log.

Revision ID: 0002
Revises: 0001
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

READONLY_ROLE = "app_ro"
TABLES = ["companies", "counterparties", "items", "documents", "ledger_entries", "invoices", "audit_findings"]


def upgrade() -> None:
    tables = ", ".join(TABLES)
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{READONLY_ROLE}') THEN
                GRANT USAGE ON SCHEMA public TO {READONLY_ROLE};
                GRANT SELECT ON {tables} TO {READONLY_ROLE};
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    tables = ", ".join(TABLES)
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{READONLY_ROLE}') THEN
                REVOKE SELECT ON {tables} FROM {READONLY_ROLE};
            END IF;
        END $$;
        """
    )
