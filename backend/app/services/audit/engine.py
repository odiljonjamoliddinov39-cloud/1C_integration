"""Rule engine for the auto audit (Function D).

A rule is one function `rule(ctx) -> list[Hit]` registered with `@rule(...)`. The engine turns hits
into `audit_findings` rows:

* a new hit opens a finding;
* a finding that no longer fires is closed as `fixed`;
* an `ignored` finding stays hidden until the data behind it changes (its fingerprint differs).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from functools import cached_property
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.models import AuditFinding, Company, Counterparty, Document, Item, LedgerEntry

CRITICAL, HIGH, MEDIUM, LOW = "critical", "high", "medium", "low"

# Finding messages are written in Russian, like the 1C documents they describe.
DOC_TYPE_NAMES = {
    "sale": "Реализация",
    "purchase": "Поступление",
    "invoice_out": "Счёт-фактура выданный",
    "invoice_in": "Счёт-фактура полученный",
    "cash_in": "ПКО",
    "cash_out": "РКО",
    "bank_in": "Поступление на р/с",
    "bank_out": "Списание с р/с",
    "operation": "Операция",
}


def pct(value) -> str:
    """12.00 -> "12", 12.5 -> "12.5" for messages."""
    return format(Decimal(str(value)).normalize(), "f")
SEVERITY_ORDER = {CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3}


class FixType:
    FILL_FIELD = "fill_field"
    REPOST = "repost"
    CORRECT_VAT = "correct_vat"
    REVERSE_DUPLICATE = "reverse_duplicate"
    MERGE_COUNTERPARTIES = "merge_counterparties"
    ALL = (FILL_FIELD, REPOST, CORRECT_VAT, REVERSE_DUPLICATE, MERGE_COUNTERPARTIES)


@dataclass
class Hit:
    object_ref: str
    message: str
    object_type: str = "document"
    object_date: datetime | None = None
    amount: Decimal | None = None
    details: dict = field(default_factory=dict)
    # What the finding is about; when this changes, an ignored finding re-opens.
    fingerprint_data: Any = None


@dataclass
class RuleDef:
    code: str
    severity: str
    fix_type: str | None
    title: str
    func: Callable[[AuditContext], list[Hit]]


RULES: dict[str, RuleDef] = {}


def rule(code: str, severity: str, fix_type: str | None, title: str):
    def decorator(func):
        RULES[code] = RuleDef(code, severity, fix_type, title, func)
        return func

    return decorator


class AuditContext:
    """Lazily loads the mirror for one company so each rule reads it once."""

    def __init__(self, db: Session, company: Company, today: date | None = None, settings: Settings | None = None):
        self.db = db
        self.company = company
        self.company_id = company.id
        self.today = today or date.today()
        self.settings = settings or get_settings()

    @cached_property
    def documents(self) -> list[Document]:
        return list(
            self.db.scalars(
                select(Document)
                .where(Document.company_id == self.company_id, Document.deleted.is_(False))
                .order_by(Document.date, Document.number)
            )
        )

    @cached_property
    def entries(self) -> list[LedgerEntry]:
        return list(
            self.db.scalars(
                select(LedgerEntry)
                .where(LedgerEntry.company_id == self.company_id)
                .order_by(LedgerEntry.date, LedgerEntry.id)
            )
        )

    @cached_property
    def counterparties(self) -> list[Counterparty]:
        return list(
            self.db.scalars(
                select(Counterparty).where(
                    Counterparty.company_id == self.company_id, Counterparty.deleted.is_(False)
                )
            )
        )

    @cached_property
    def items(self) -> dict[str, Item]:
        return {
            i.ref_1c: i
            for i in self.db.scalars(
                select(Item).where(Item.company_id == self.company_id, Item.deleted.is_(False))
            )
        }

    @cached_property
    def documents_by_ref(self) -> dict[str, Document]:
        return {d.ref_1c: d for d in self.documents}

    def doc_label(self, doc: Document) -> str:
        return f"{DOC_TYPE_NAMES.get(doc.type, doc.type)} №{doc.number} от {doc.date:%d.%m.%Y}"


def fingerprint(hit: Hit) -> str:
    data = hit.fingerprint_data if hit.fingerprint_data is not None else hit.details
    raw = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def _in_closed_period(company: Company, when: datetime | None) -> bool:
    return bool(company.closed_period_until and when and when.date() <= company.closed_period_until)


def run_audit(db: Session, company: Company, today: date | None = None, codes: list[str] | None = None):
    """Run the rules (all, or `codes`) and reconcile findings. Returns the ids of new/reopened findings."""
    # Import the rule modules so they register themselves.
    from app.services.audit import rules  # noqa: F401

    ctx = AuditContext(db, company, today)
    selected = [RULES[c] for c in codes] if codes else list(RULES.values())
    existing = {
        (f.rule_code, f.object_ref): f
        for f in db.scalars(
            select(AuditFinding).where(
                AuditFinding.company_id == company.id,
                AuditFinding.rule_code.in_([r.code for r in selected]),
            )
        )
    }
    now = datetime.now(timezone.utc)
    seen: set[tuple[str, str]] = set()
    opened: list[AuditFinding] = []

    for rule_def in selected:
        for hit in rule_def.func(ctx):
            key = (rule_def.code, hit.object_ref)
            if key in seen:
                continue
            seen.add(key)
            fp = fingerprint(hit)
            closed = _in_closed_period(company, hit.object_date)
            details = dict(hit.details)
            if closed:
                details["closed_period"] = True
                details["note"] = "correct in the current period"
            finding = existing.get(key)
            if finding is None:
                finding = AuditFinding(
                    company_id=company.id,
                    rule_code=rule_def.code,
                    object_ref=hit.object_ref,
                    status="open",
                    fingerprint=fp,
                    first_seen=now,
                )
                db.add(finding)
                opened.append(finding)
            elif finding.status == "ignored":
                if finding.fingerprint != fp:
                    finding.status = "open"
                    finding.ai_explanation = None
                    finding.fingerprint = fp
                    opened.append(finding)
            else:
                if finding.status == "fixed":
                    finding.status = "open"
                    finding.resolved_at = None
                    opened.append(finding)
                if finding.fingerprint != fp:
                    finding.ai_explanation = None
                finding.fingerprint = fp
            finding.severity = rule_def.severity
            finding.fix_type = None if closed else rule_def.fix_type
            finding.object_type = hit.object_type
            finding.object_date = hit.object_date
            finding.amount = hit.amount
            finding.message = hit.message
            finding.details = details
            finding.last_seen = now

    for key, finding in existing.items():
        if key not in seen and finding.status in ("open", "ignored"):
            finding.status = "fixed"
            finding.resolved_at = now

    db.flush()
    return [f.id for f in opened]


def rule_still_fires(db: Session, company: Company, rule_code: str, object_ref: str) -> bool:
    from app.services.audit import rules  # noqa: F401

    ctx = AuditContext(db, company)
    return any(hit.object_ref == object_ref for hit in RULES[rule_code].func(ctx))
