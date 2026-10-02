"""Companies, catalogs (for forms), documents (click-through) and the analytics widgets."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import allowed_company_ids, check_company, get_current_user, require_writer, resolve_companies
from app.models import Company, Counterparty, Document, Item, LedgerEntry, User, log_event
from app.routers.common import company_out, document_out, num, table_to_xlsx
from app.services import analytics
from app.services.agent_gateway import RedisAgentGateway, get_gateway

router = APIRouter(prefix="/api", tags=["data"])


def _agent_status(company_id: int) -> tuple[bool | None, int | None]:
    gateway = get_gateway()
    online = gateway.is_online(company_id)
    pending = gateway.pending(company_id) if isinstance(gateway, RedisAgentGateway) else None
    return online, pending


@router.get("/companies")
def list_companies(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ids = allowed_company_ids(db, user)
    companies = db.scalars(select(Company).where(Company.id.in_(ids)).order_by(Company.name))
    return [company_out(c, *_agent_status(c.id)) for c in companies]


@router.post("/companies/{company_id}/sync")
def sync_now(company_id: int, full: bool = False, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    from app.jobs import enqueue, sync_company

    check_company(db, user, company_id)
    log_event(db, "sync.requested", user_id=user.id, company_id=company_id, full=full)
    db.commit()
    enqueue(sync_company, company_id, full)
    return {"queued": True}


@router.get("/companies/{company_id}/counterparties")
def search_counterparties(
    company_id: int,
    q: str = "",
    ref: str | None = None,
    limit: int = 20,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    check_company(db, user, company_id)
    query = select(Counterparty).where(Counterparty.company_id == company_id, Counterparty.deleted.is_(False))
    if ref:
        query = query.where(Counterparty.ref_1c == ref)
    if q:
        query = query.where(or_(Counterparty.name.ilike(f"%{q}%"), Counterparty.inn.like(f"{q}%")))
    return [
        {"ref_1c": c.ref_1c, "name": c.name, "inn": c.inn, "contracts": c.contract_refs}
        for c in db.scalars(query.order_by(Counterparty.name).limit(min(limit, 100)))
    ]


@router.get("/companies/{company_id}/items")
def search_items(
    company_id: int, q: str = "", limit: int = 20, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    check_company(db, user, company_id)
    query = select(Item).where(Item.company_id == company_id, Item.deleted.is_(False))
    if q:
        query = query.where(or_(Item.name.ilike(f"%{q}%"), Item.ikpu_code.like(f"{q}%")))
    return [
        {"ref_1c": i.ref_1c, "name": i.name, "unit": i.unit, "price": num(i.price), "vat_rate": num(i.vat_rate), "ikpu_code": i.ikpu_code}
        for i in db.scalars(query.order_by(Item.name).limit(min(limit, 100)))
    ]


@router.get("/documents")
def list_documents(
    company_id: int | None = None,
    type: str | None = None,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    counterparty_ref: str | None = None,
    account: str | None = None,
    refs: str | None = None,
    posted: bool | None = None,
    format: str = "json",
    limit: int = 500,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The documents behind any dashboard number. `account` keeps documents with entries on it."""
    ids = resolve_companies(db, user, company_id)
    q = select(Document).where(Document.company_id.in_(ids), Document.deleted.is_(False))
    if type:
        q = q.where(Document.type.in_(type.split(",")))
    if date_from:
        q = q.where(Document.date >= analytics.start_of(date_from))
    if date_to:
        q = q.where(Document.date < analytics.end_of(date_to))
    if counterparty_ref:
        q = q.where(Document.counterparty_ref == counterparty_ref)
    if posted is not None:
        q = q.where(Document.posted.is_(posted))
    if refs:
        q = q.where(Document.ref_1c.in_(refs.split(",")))
    if account:
        sub = select(LedgerEntry.document_ref).where(
            LedgerEntry.company_id.in_(ids),
            or_(LedgerEntry.dt_account.like(f"{account}%"), LedgerEntry.kt_account.like(f"{account}%")),
        )
        if date_from:
            sub = sub.where(LedgerEntry.date >= analytics.start_of(date_from))
        if date_to:
            sub = sub.where(LedgerEntry.date < analytics.end_of(date_to))
        q = q.where(Document.ref_1c.in_(sub))
    docs = list(db.scalars(q.order_by(Document.date.desc(), Document.number.desc()).limit(min(limit, 5000))))
    names = {
        (c.company_id, c.ref_1c): c.name
        for c in db.execute(
            select(Counterparty.company_id, Counterparty.ref_1c, Counterparty.name).where(
                Counterparty.ref_1c.in_({d.counterparty_ref for d in docs if d.counterparty_ref}),
                Counterparty.company_id.in_(ids),
            )
        )
    }
    out = [{**document_out(d), "counterparty": names.get((d.company_id, d.counterparty_ref), "")} for d in docs]
    if format == "xlsx":
        return table_to_xlsx("documents", out)
    return out


@router.get("/documents/{company_id}/{ref}")
def get_document(company_id: int, ref: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    check_company(db, user, company_id)
    doc = db.scalar(select(Document).where(Document.company_id == company_id, Document.ref_1c == ref))
    entries = db.scalars(
        select(LedgerEntry).where(LedgerEntry.company_id == company_id, LedgerEntry.document_ref == ref).order_by(LedgerEntry.id)
    )
    return {
        "document": {**document_out(doc), "rows": (doc.raw_json or {}).get("rows", [])} if doc else None,
        "entries": [
            {"date": e.date.isoformat(), "dt": e.dt_account, "kt": e.kt_account, "amount": num(e.amount), "subconto": e.subconto_json}
            for e in entries
        ],
    }


# --- analytics -------------------------------------------------------------------------------


def _period(on: date | None, start: date | None) -> tuple[date, date]:
    on = on or date.today()
    return on, start or date(on.year, 1, 1)


@router.get("/analytics/dashboard")
def dashboard(
    company_id: int | None = None,
    on: date | None = Query(None, alias="date"),
    start: date | None = Query(None, alias="from"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ids = resolve_companies(db, user, company_id)
    on, start = _period(on, start)
    last_synced = db.scalar(select(func.min(Company.last_synced_at)).where(Company.id.in_(ids)))
    return {
        "company_ids": ids,
        "date": on.isoformat(),
        "from": start.isoformat(),
        "last_synced_at": last_synced.isoformat() if last_synced else None,
        **analytics.dashboard(db, ids, on, start),
    }


@router.get("/analytics/receivables")
def receivables(
    company_id: int | None = None,
    on: date | None = Query(None, alias="date"),
    counterparty_ref: str | None = None,
    format: str = "json",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ids = resolve_companies(db, user, company_id)
    data = analytics.receivables_payables(db, ids, on or date.today(), counterparty_ref)
    if format == "xlsx":
        rows = [{"kind": k, **r} for k in ("receivables", "payables") for r in data[k]["top"]]
        return table_to_xlsx("receivables_payables", rows)
    return data


@router.get("/analytics/aging")
def aging(
    company_id: int | None = None,
    on: date | None = Query(None, alias="date"),
    format: str = "json",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ids = resolve_companies(db, user, company_id)
    data = analytics.debt_aging(db, ids, on or date.today())
    return table_to_xlsx("debt_aging", data["counterparties"]) if format == "xlsx" else data


@router.get("/analytics/sales")
def sales(
    company_id: int | None = None,
    start: date | None = Query(None, alias="from"),
    end: date | None = Query(None, alias="to"),
    format: str = "json",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ids = resolve_companies(db, user, company_id)
    end = end or date.today()
    data = analytics.sales_purchases(db, ids, start or end - timedelta(days=365), end)
    return table_to_xlsx("sales_purchases", data) if format == "xlsx" else data


@router.get("/analytics/vat")
def vat(
    company_id: int | None = None,
    start: date | None = Query(None, alias="from"),
    end: date | None = Query(None, alias="to"),
    format: str = "json",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ids = resolve_companies(db, user, company_id)
    end = end or date.today()
    data = analytics.vat_summary(db, ids, start or date(end.year, 1, 1), end)
    return table_to_xlsx("vat", data) if format == "xlsx" else data


@router.get("/analytics/trial-balance")
def trial_balance(
    company_id: int | None = None,
    start: date | None = Query(None, alias="from"),
    end: date | None = Query(None, alias="to"),
    account: str | None = None,
    format: str = "json",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ids = resolve_companies(db, user, company_id)
    end = end or date.today()
    data = analytics.trial_balance(db, ids, start or date(end.year, end.month, 1), end, account)
    return table_to_xlsx("trial_balance", data) if format == "xlsx" else data
