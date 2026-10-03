"""The twelve PostgreSQL tables (spec: "Backend data model").

Every business table carries `company_id`; 1C objects keep their 1C reference (`ref_1c`, the UUID)
so updates coming from sync match rows exactly. Columns beyond the spec's "key columns" are the
small extras the features need (timestamps, fingerprints for ignored findings, TOTP secret, ...).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, JSONType

Money = Numeric(18, 2)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_uuid() -> str:
    return str(uuid.uuid4())


class Role:
    OWNER = "owner"
    ACCOUNTANT = "accountant"
    VIEWER = "viewer"
    ALL = (OWNER, ACCOUNTANT, VIEWER)


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    inn: Mapped[str] = mapped_column(String(14), default="")
    base_path: Mapped[str] = mapped_column(String(500), default="")
    # Base path of the published extension as the agent sees it, e.g. http://127.0.0.1:8080/TEST_CRYSTAL
    agent_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sync_cursor: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_period_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Set when the agent turns out to be connected to a different base (wrong INN or base name);
    # sync and writes are refused until it is cleared by a matching /ping.
    base_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default=Role.VIEWER)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    totp_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    mcp_token_hash: Mapped[str | None] = mapped_column(String(128), nullable=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class UserCompany(Base):
    __tablename__ = "user_companies"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    company_id: Mapped[int] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), primary_key=True
    )


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(128), unique=True)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    version: Mapped[str] = mapped_column(String(50), default="")
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Counterparty(Base):
    __tablename__ = "counterparties"
    __table_args__ = (UniqueConstraint("company_id", "ref_1c"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    ref_1c: Mapped[str] = mapped_column(String(36))
    name: Mapped[str] = mapped_column(String(500), default="")
    inn: Mapped[str] = mapped_column(String(14), default="")
    contract_refs: Mapped[list] = mapped_column(JSONType, default=list)
    # [{"ref": uuid, "name": "Договор №1", "number": "1", "date": "2026-01-01"}]
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)


class Item(Base):
    __tablename__ = "items"
    __table_args__ = (UniqueConstraint("company_id", "ref_1c"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    ref_1c: Mapped[str] = mapped_column(String(36))
    name: Mapped[str] = mapped_column(String(500), default="")
    unit: Mapped[str] = mapped_column(String(50), default="")
    price: Mapped[Decimal] = mapped_column(Money, default=0)
    vat_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    ikpu_code: Mapped[str] = mapped_column(String(32), default="")
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("company_id", "ref_1c"),
        Index("ix_documents_company_date", "company_id", "date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"))
    ref_1c: Mapped[str] = mapped_column(String(36))
    type: Mapped[str] = mapped_column(String(40))
    number: Mapped[str] = mapped_column(String(50), default="")
    date: Mapped[datetime] = mapped_column(DateTime)
    posted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    counterparty_ref: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    contract_ref: Mapped[str | None] = mapped_column(String(36), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Money, default=0)
    vat: Mapped[Decimal] = mapped_column(Money, default=0)
    raw_json: Mapped[dict] = mapped_column(JSONType, default=dict)
    # raw_json["rows"]: [{"item_ref", "quantity", "price", "amount", "vat_rate", "vat_amount", "warehouse_ref"}]


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"
    __table_args__ = (
        Index("ix_ledger_company_date", "company_id", "date"),
        Index("ix_ledger_document", "company_id", "document_ref"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"))
    # Registrar UUID. Opening balances loaded by the first sync use document_ref = "OPENING".
    document_ref: Mapped[str] = mapped_column(String(36))
    date: Mapped[datetime] = mapped_column(DateTime)
    dt_account: Mapped[str] = mapped_column(String(20), index=True)
    kt_account: Mapped[str] = mapped_column(String(20), index=True)
    amount: Mapped[Decimal] = mapped_column(Money)
    subconto_json: Mapped[dict] = mapped_column(JSONType, default=dict)
    # {"dt": {"counterparty_ref", "contract_ref", "item_ref", "warehouse_ref", "quantity"}, "kt": {...}}


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    ref_1c: Mapped[str | None] = mapped_column(String(36), nullable=True)
    number: Mapped[str] = mapped_column(String(50), default="")
    date: Mapped[date] = mapped_column(Date)
    buyer_ref: Mapped[str | None] = mapped_column(String(36), nullable=True)
    buyer_inn: Mapped[str] = mapped_column(String(14), default="")
    buyer_name: Mapped[str] = mapped_column(String(500), default="")
    contract_ref: Mapped[str | None] = mapped_column(String(36), nullable=True)
    rows: Mapped[list] = mapped_column(JSONType, default=list)
    # [{"item_ref", "name", "unit", "ikpu_code", "quantity", "price", "vat_rate", "amount", "vat"}]
    total: Mapped[Decimal] = mapped_column(Money, default=0)
    vat: Mapped[Decimal] = mapped_column(Money, default=0)
    # draft (only in the app) -> created (unposted in 1C) -> posted -> ready/sent -> signed | rejected
    status: Mapped[str] = mapped_column(String(20), default="draft")
    operator_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    operator_message: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class AuditFinding(Base):
    __tablename__ = "audit_findings"
    __table_args__ = (
        UniqueConstraint("company_id", "rule_code", "object_ref"),
        Index("ix_findings_company_status", "company_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"))
    rule_code: Mapped[str] = mapped_column(String(30))
    severity: Mapped[str] = mapped_column(String(10))
    object_ref: Mapped[str] = mapped_column(String(120))
    object_type: Mapped[str] = mapped_column(String(30), default="document")
    object_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    amount: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    message: Mapped[str] = mapped_column(Text)
    details: Mapped[dict] = mapped_column(JSONType, default=dict)
    fix_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    ai_explanation: Mapped[str | None] = mapped_column(Text, nullable=True)
    # open | fixed | ignored
    status: Mapped[str] = mapped_column(String(10), default="open")
    # Hash of the data behind the finding: an ignored finding re-opens only when this changes.
    fingerprint: Mapped[str] = mapped_column(String(64), default="")
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Fix(Base):
    __tablename__ = "fixes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    finding_id: Mapped[int | None] = mapped_column(
        ForeignKey("audit_findings.id", ondelete="SET NULL"), nullable=True
    )
    fix_type: Mapped[str] = mapped_column(String(30))
    proposed_change_json: Mapped[dict] = mapped_column(JSONType, default=dict)
    explanation: Mapped[str] = mapped_column(Text, default="")
    requested_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approval_id: Mapped[str | None] = mapped_column(String(36), nullable=True, unique=True)
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # proposed -> approved (queued for agent) -> applied | failed ; rejected
    status: Mapped[str] = mapped_column(String(12), default="proposed")
    result: Mapped[str] = mapped_column(Text, default="")
    before_json: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    after_json: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    reverses_fix_id: Mapped[int | None] = mapped_column(ForeignKey("fixes.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EventLog(Base):
    __tablename__ = "event_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    company_id: Mapped[int | None] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=True, index=True
    )
    action: Mapped[str] = mapped_column(String(60))
    object_ref: Mapped[str] = mapped_column(String(120), default="")
    details: Mapped[dict] = mapped_column(JSONType, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


def log_event(db, action: str, *, user_id=None, company_id=None, object_ref="", **details) -> None:
    db.add(
        EventLog(
            user_id=user_id,
            company_id=company_id,
            action=action,
            object_ref=str(object_ref or ""),
            details=details,
        )
    )
