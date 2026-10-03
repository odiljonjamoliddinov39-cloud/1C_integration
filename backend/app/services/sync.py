"""Mirror 1C data into PostgreSQL.

First sync: all catalogs, the current plus previous year of documents and entries, and opening
balances at the start of that window (stored as ledger entries with document_ref = "OPENING").
Incremental sync (every 5 minutes or "Sync now"): `/changes?since=<cursor>` lists what changed;
only those catalogs and documents (and the documents' entries) are fetched again.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import Company, Counterparty, Document, Item, LedgerEntry, log_event

DOCUMENT_TYPES = [
    "sale",
    "purchase",
    "invoice_out",
    "invoice_in",
    "cash_in",
    "cash_out",
    "bank_in",
    "bank_out",
    "operation",  # Операция (бухгалтерская): manual entries, no rows
]
OPENING_REF = "OPENING"
OPENING_COUNTER_ACCOUNT = "000"

Fetch = Callable[[str, dict], Any]  # (command, params) -> data, e.g. gateway.call bound to a company


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)


def dec(value) -> Decimal:
    return Decimal(str(value or 0))


def full_sync_window(today: date | None = None) -> tuple[date, date]:
    today = today or date.today()
    return date(today.year - 1, 1, 1), today


# --- upserts ---------------------------------------------------------------------------------


def upsert_counterparties(db: Session, company_id: int, rows: list[dict]) -> int:
    existing = {
        c.ref_1c: c
        for c in db.scalars(
            select(Counterparty).where(
                Counterparty.company_id == company_id,
                Counterparty.ref_1c.in_([r["ref"] for r in rows]),
            )
        )
    }
    for r in rows:
        cp = existing.get(r["ref"])
        if cp is None:
            cp = Counterparty(company_id=company_id, ref_1c=r["ref"], contract_refs=[])
            db.add(cp)
        cp.name = r.get("name", "")
        cp.inn = (r.get("inn") or "").strip()
        cp.deleted = bool(r.get("deleted"))
    return len(rows)


def attach_contracts(db: Session, company_id: int, rows: list[dict]) -> int:
    by_owner: dict[str, list[dict]] = {}
    for r in rows:
        by_owner.setdefault(r["owner_ref"], []).append(r)
    for cp in db.scalars(
        select(Counterparty).where(
            Counterparty.company_id == company_id, Counterparty.ref_1c.in_(list(by_owner))
        )
    ):
        contracts = {c["ref"]: c for c in cp.contract_refs or []}
        for r in by_owner[cp.ref_1c]:
            if r.get("deleted"):
                contracts.pop(r["ref"], None)
            else:
                contracts[r["ref"]] = {
                    "ref": r["ref"],
                    "name": r.get("name", ""),
                    "number": r.get("number", ""),
                    "date": r.get("date"),
                }
        cp.contract_refs = list(contracts.values())
    return len(rows)


def upsert_items(db: Session, company_id: int, rows: list[dict]) -> int:
    existing = {
        i.ref_1c: i
        for i in db.scalars(
            select(Item).where(Item.company_id == company_id, Item.ref_1c.in_([r["ref"] for r in rows]))
        )
    }
    for r in rows:
        item = existing.get(r["ref"])
        if item is None:
            item = Item(company_id=company_id, ref_1c=r["ref"])
            db.add(item)
        item.name = r.get("name", "")
        item.unit = r.get("unit", "")
        item.price = dec(r.get("price"))
        item.vat_rate = None if r.get("vat_rate") is None else dec(r["vat_rate"])
        item.ikpu_code = (r.get("ikpu_code") or "").strip()
        item.deleted = bool(r.get("deleted"))
    return len(rows)


def upsert_documents(db: Session, company_id: int, rows: list[dict]) -> int:
    existing = {
        d.ref_1c: d
        for d in db.scalars(
            select(Document).where(
                Document.company_id == company_id, Document.ref_1c.in_([r["ref"] for r in rows])
            )
        )
    }
    for r in rows:
        doc = existing.get(r["ref"])
        if doc is None:
            doc = Document(company_id=company_id, ref_1c=r["ref"])
            db.add(doc)
        doc.type = r["type"]
        doc.number = r.get("number", "")
        doc.date = parse_dt(r["date"])
        doc.posted = bool(r.get("posted"))
        doc.deleted = bool(r.get("deleted"))
        doc.counterparty_ref = r.get("counterparty_ref") or None
        doc.contract_ref = r.get("contract_ref") or None
        doc.amount = dec(r.get("amount"))
        doc.vat = dec(r.get("vat"))
        doc.raw_json = r
    return len(rows)


def entry_from_row(company_id: int, r: dict) -> LedgerEntry:
    return LedgerEntry(
        company_id=company_id,
        document_ref=r["document_ref"],
        date=parse_dt(r["date"]),
        dt_account=r["dt"],
        kt_account=r["kt"],
        amount=dec(r["amount"]),
        subconto_json=r.get("subconto") or {},
    )


def replace_entries_for_period(db: Session, company_id: int, start: date, end: date, rows: list[dict]):
    db.execute(
        delete(LedgerEntry).where(
            LedgerEntry.company_id == company_id,
            LedgerEntry.document_ref != OPENING_REF,
            LedgerEntry.date >= datetime.combine(start, datetime.min.time()),
            LedgerEntry.date < datetime.combine(end + timedelta(days=1), datetime.min.time()),
        )
    )
    db.add_all(entry_from_row(company_id, r) for r in rows)


def replace_entries_for_documents(db: Session, company_id: int, refs: list[str], rows: list[dict]):
    if not refs:
        return
    db.execute(
        delete(LedgerEntry).where(
            LedgerEntry.company_id == company_id, LedgerEntry.document_ref.in_(refs)
        )
    )
    db.add_all(entry_from_row(company_id, r) for r in rows)


def store_opening_balances(db: Session, company_id: int, on: date, rows: list[dict]) -> None:
    """Balances at the start of the window become one entry per account/subconto against 000."""
    db.execute(
        delete(LedgerEntry).where(
            LedgerEntry.company_id == company_id, LedgerEntry.document_ref == OPENING_REF
        )
    )
    when = datetime.combine(on - timedelta(days=1), datetime.max.time().replace(microsecond=0))
    for r in rows:
        balance = dec(r.get("debit")) - dec(r.get("credit"))
        subconto = r.get("subconto") or {}
        if r.get("quantity") is not None:
            subconto = {**subconto, "quantity": r["quantity"]}
        if balance == 0 and not subconto.get("quantity"):
            continue
        if balance >= 0:
            dt, kt, sub = r["account"], OPENING_COUNTER_ACCOUNT, {"dt": subconto, "kt": {}}
        else:
            dt, kt, sub = OPENING_COUNTER_ACCOUNT, r["account"], {"dt": {}, "kt": subconto}
        db.add(
            LedgerEntry(
                company_id=company_id,
                document_ref=OPENING_REF,
                date=when,
                dt_account=dt,
                kt_account=kt,
                amount=abs(balance),
                subconto_json=sub,
            )
        )


# --- sync runs -------------------------------------------------------------------------------


def _apply_ping(db: Session, company: Company, info: dict) -> None:
    from app.services.onec import check_base

    check_base(db, company, info)  # raises WrongBase if the agent sits on another base
    if "closed_period_until" in info:
        company.closed_period_until = (
            date.fromisoformat(info["closed_period_until"]) if info["closed_period_until"] else None
        )


def full_sync(db: Session, company: Company, fetch: Fetch, today: date | None = None) -> dict:
    start, end = full_sync_window(today)
    stats: dict[str, int] = {}

    _apply_ping(db, company, fetch("ping", {}))
    changes = fetch("get_changes", {"since": None})  # take the cursor *before* reading data

    stats["counterparties"] = upsert_counterparties(
        db, company.id, fetch("get_catalog", {"name": "counterparties"})["items"]
    )
    db.flush()
    stats["contracts"] = attach_contracts(
        db, company.id, fetch("get_catalog", {"name": "contracts"})["items"]
    )
    stats["items"] = upsert_items(db, company.id, fetch("get_catalog", {"name": "items"})["items"])

    stats["documents"] = 0
    for doc_type in DOCUMENT_TYPES:
        rows = fetch(
            "get_documents", {"type": doc_type, "from": start.isoformat(), "to": end.isoformat()}
        )["items"]
        stats["documents"] += upsert_documents(db, company.id, rows)

    store_opening_balances(
        db, company.id, start, fetch("get_balances", {"date": start.isoformat()})["items"]
    )
    entries = fetch("get_ledger", {"from": start.isoformat(), "to": end.isoformat()})["items"]
    replace_entries_for_period(db, company.id, start, end, entries)
    stats["ledger_entries"] = len(entries)

    company.sync_cursor = changes.get("cursor")
    company.last_synced_at = datetime.now(timezone.utc)
    log_event(db, "sync.full", company_id=company.id, **stats)
    db.commit()
    return stats


def incremental_sync(db: Session, company: Company, fetch: Fetch) -> dict:
    if not company.sync_cursor:
        return full_sync(db, company, fetch)
    from app.services.onec import ensure_right_base

    ensure_right_base(db, company, fetch)  # raises WrongBase before anything is mirrored

    changes = fetch("get_changes", {"since": company.sync_cursor})
    items = changes.get("items", [])
    catalogs: dict[str, list[str]] = {}
    for c in items:
        if c["kind"] == "catalog":
            catalogs.setdefault(c["name"], []).append(c["ref"])
    docs_by_type: dict[str, list[str]] = {}
    for c in items:
        if c["kind"] == "document":
            docs_by_type.setdefault(c["type"], []).append(c["ref"])

    stats = {"changes": len(items)}
    if "counterparties" in catalogs:
        rows = fetch("get_catalog", {"name": "counterparties", "refs": catalogs["counterparties"]})["items"]
        stats["counterparties"] = upsert_counterparties(db, company.id, rows)
        db.flush()
    if "contracts" in catalogs:
        rows = fetch("get_catalog", {"name": "contracts", "refs": catalogs["contracts"]})["items"]
        stats["contracts"] = attach_contracts(db, company.id, rows)
    if "items" in catalogs:
        rows = fetch("get_catalog", {"name": "items", "refs": catalogs["items"]})["items"]
        stats["items"] = upsert_items(db, company.id, rows)

    all_refs: list[str] = []
    for doc_type, refs in docs_by_type.items():
        rows = fetch("get_documents", {"type": doc_type, "refs": refs})["items"]
        upsert_documents(db, company.id, rows)
        all_refs.extend(refs)
    mark_physically_deleted(db, company.id, items)
    if all_refs:
        types = {r: t for t, refs in docs_by_type.items() for r in refs}
        entries = fetch("get_ledger", {"refs": all_refs, "types": types})["items"]
        replace_entries_for_documents(db, company.id, all_refs, entries)
    stats["documents"] = len(all_refs)

    if "organizations" in catalogs:
        _apply_ping(db, company, fetch("ping", {}))

    company.sync_cursor = changes.get("cursor") or company.sync_cursor
    company.last_synced_at = datetime.now(timezone.utc)
    log_event(db, "sync.incremental", company_id=company.id, **stats)
    db.commit()
    return stats


def mark_physically_deleted(db: Session, company_id: int, changes: list[dict]) -> None:
    """Objects deleted from the base (not just marked) are flagged deleted in the mirror."""
    gone = {c["ref"] for c in changes if c.get("deleted") and c.get("removed")}
    if not gone:
        return
    for model in (Document, Counterparty, Item):
        for obj in db.scalars(select(model).where(model.company_id == company_id, model.ref_1c.in_(gone))):
            obj.deleted = True


def resync_documents(db: Session, company: Company, fetch: Fetch, refs_by_type: dict[str, list[str]]):
    """Re-read specific documents after a fix or invoice write."""
    all_refs = []
    for doc_type, refs in refs_by_type.items():
        if refs:
            upsert_documents(db, company.id, fetch("get_documents", {"type": doc_type, "refs": refs})["items"])
            all_refs.extend(refs)
    if all_refs:
        types = {r: t for t, refs in refs_by_type.items() for r in refs}
        entries = fetch("get_ledger", {"refs": all_refs, "types": types})["items"]
        replace_entries_for_documents(db, company.id, all_refs, entries)
    db.flush()


def resync_catalog_refs(db: Session, company: Company, fetch: Fetch, name: str, refs: list[str]):
    rows = fetch("get_catalog", {"name": name, "refs": refs})["items"]
    if name == "counterparties":
        upsert_counterparties(db, company.id, rows)
    elif name == "items":
        upsert_items(db, company.id, rows)
    db.flush()
