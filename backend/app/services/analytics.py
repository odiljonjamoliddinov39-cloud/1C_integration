"""Dashboard widgets (Function B), computed from the PostgreSQL mirror so 1C is never slowed down.

Every function takes a list of company ids: one company, or all companies the user can see for
the combined view. Aggregation happens in SQL; only the debt aging walks entries in Python (FIFO).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import and_, case, func, literal, or_, select, union_all
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import AuditFinding, Counterparty, Document, LedgerEntry
from app.services.ledger import aging, open_lots

ZERO = Decimal("0")


def end_of(day: date) -> datetime:
    return datetime.combine(day + timedelta(days=1), datetime.min.time())


def start_of(day: date) -> datetime:
    return datetime.combine(day, datetime.min.time())


def _balance(db: Session, company_ids: list[int], prefix: str, on: date) -> Decimal:
    e = LedgerEntry
    dt = func.coalesce(func.sum(case((e.dt_account.like(f"{prefix}%"), e.amount), else_=0)), 0)
    kt = func.coalesce(func.sum(case((e.kt_account.like(f"{prefix}%"), e.amount), else_=0)), 0)
    row = db.execute(
        select(dt, kt).where(
            e.company_id.in_(company_ids),
            e.date < end_of(on),
            or_(e.dt_account.like(f"{prefix}%"), e.kt_account.like(f"{prefix}%")),
        )
    ).one()
    return Decimal(row[0]) - Decimal(row[1])


def cash_and_bank(db: Session, company_ids: list[int], on: date, days: int = 90) -> dict:
    s = get_settings()
    result = {}
    for key, prefix in (("cash", s.cash_account), ("bank", s.bank_account)):
        start = on - timedelta(days=days - 1)
        opening = _balance(db, company_ids, prefix, start - timedelta(days=1))
        e = LedgerEntry
        day = func.date_trunc("day", e.date).label("day")
        delta = func.sum(
            case((e.dt_account.like(f"{prefix}%"), e.amount), else_=0)
            - case((e.kt_account.like(f"{prefix}%"), e.amount), else_=0)
        )
        rows = db.execute(
            select(day, delta)
            .where(
                e.company_id.in_(company_ids),
                e.date >= start_of(start),
                e.date < end_of(on),
                or_(e.dt_account.like(f"{prefix}%"), e.kt_account.like(f"{prefix}%")),
            )
            .group_by(day)
            .order_by(day)
        ).all()
        moves = {r[0].date(): Decimal(r[1]) for r in rows}
        series, balance = [], opening
        for i in range(days):
            d = start + timedelta(days=i)
            balance += moves.get(d, ZERO)
            series.append({"date": d.isoformat(), "balance": str(balance)})
        result[key] = {"account": prefix, "balance": str(balance), "series": series}
    return result


def _counterparty_balances(db: Session, company_ids: list[int], prefix: str, on: date, debit_positive: bool):
    e = LedgerEntry
    dt_side = select(
        e.company_id.label("company_id"),
        e.subconto_json["dt"]["counterparty_ref"].as_string().label("cp"),
        e.amount.label("amount"),
    ).where(e.company_id.in_(company_ids), e.date < end_of(on), e.dt_account.like(f"{prefix}%"))
    kt_side = select(
        e.company_id.label("company_id"),
        e.subconto_json["kt"]["counterparty_ref"].as_string().label("cp"),
        (-e.amount).label("amount"),
    ).where(e.company_id.in_(company_ids), e.date < end_of(on), e.kt_account.like(f"{prefix}%"))
    u = union_all(dt_side, kt_side).subquery()
    total = func.sum(u.c.amount)
    if not debit_positive:
        total = -total
    rows = db.execute(
        select(u.c.company_id, u.c.cp, total.label("balance")).group_by(u.c.company_id, u.c.cp)
    ).all()
    return [(r.company_id, r.cp, Decimal(r.balance)) for r in rows if r.balance]


def _names(db: Session, company_ids: list[int]) -> dict[tuple[int, str], str]:
    return {
        (c.company_id, c.ref_1c): c.name
        for c in db.execute(
            select(Counterparty.company_id, Counterparty.ref_1c, Counterparty.name).where(
                Counterparty.company_id.in_(company_ids)
            )
        )
    }


def receivables_payables(db: Session, company_ids: list[int], on: date, counterparty_ref: str | None = None) -> dict:
    s = get_settings()
    names = _names(db, company_ids)
    out = {}
    for key, prefix, debit_positive in (
        ("receivables", s.receivable_prefix, True),
        ("payables", s.payable_prefix, False),
    ):
        rows = _counterparty_balances(db, company_ids, prefix, on, debit_positive)
        if counterparty_ref:
            rows = [r for r in rows if r[1] == counterparty_ref]
        total = sum((b for _, _, b in rows if b > 0), ZERO)
        top = sorted((r for r in rows if r[2] > 0), key=lambda r: r[2], reverse=True)[:10]
        out[key] = {
            "total": str(total),
            "top": [
                {"company_id": cid, "counterparty_ref": cp, "name": names.get((cid, cp), cp or "—"), "balance": str(b)}
                for cid, cp, b in top
            ],
        }
    return out


def debt_aging(db: Session, company_ids: list[int], on: date) -> dict:
    s = get_settings()
    names = _names(db, company_ids)
    buckets_total = {"0-30": ZERO, "31-60": ZERO, "61-90": ZERO, "90+": ZERO}
    per_cp = []
    for cid in company_ids:
        entries = db.scalars(
            select(LedgerEntry)
            .where(
                LedgerEntry.company_id == cid,
                LedgerEntry.date < end_of(on),
                or_(
                    LedgerEntry.dt_account.like(f"{s.receivable_prefix}%"),
                    LedgerEntry.kt_account.like(f"{s.receivable_prefix}%"),
                ),
            )
            .order_by(LedgerEntry.date, LedgerEntry.id)
        )
        for cp, buckets in aging(open_lots(entries, s.receivable_prefix, as_of=on), on).items():
            for k, v in buckets.items():
                buckets_total[k] += v
            per_cp.append(
                {
                    "company_id": cid,
                    "counterparty_ref": cp,
                    "name": names.get((cid, cp), cp),
                    **{k: str(v) for k, v in buckets.items()},
                    "total": str(sum(buckets.values(), ZERO)),
                }
            )
    per_cp.sort(key=lambda r: Decimal(r["total"]), reverse=True)
    return {"buckets": {k: str(v) for k, v in buckets_total.items()}, "counterparties": per_cp[:50]}


def sales_purchases(db: Session, company_ids: list[int], start: date, end: date) -> list[dict]:
    d = Document
    month = func.date_trunc("month", d.date).label("month")
    rows = db.execute(
        select(month, d.type, func.sum(d.amount))
        .where(
            d.company_id.in_(company_ids),
            d.type.in_(["sale", "purchase"]),
            d.posted.is_(True),
            d.deleted.is_(False),
            d.date >= start_of(start),
            d.date < end_of(end),
        )
        .group_by(month, d.type)
        .order_by(month)
    ).all()
    by_month: dict[str, dict] = defaultdict(lambda: {"sales": ZERO, "purchases": ZERO})
    for m, t, total in rows:
        by_month[f"{m:%Y-%m}"]["sales" if t == "sale" else "purchases"] += Decimal(total)
    return [{"month": m, "sales": str(v["sales"]), "purchases": str(v["purchases"])} for m, v in sorted(by_month.items())]


def vat_summary(db: Session, company_ids: list[int], start: date, end: date) -> list[dict]:
    s = get_settings()
    e = LedgerEntry
    month = func.date_trunc("month", e.date).label("month")
    rows = db.execute(
        select(
            month,
            func.sum(
                case(
                    (and_(e.kt_account.like(f"{s.vat_output_account}%"), ~e.dt_account.like(f"{s.vat_output_account}%")), e.amount),
                    else_=0,
                )
            ),
            func.sum(
                case(
                    (and_(e.dt_account.like(f"{s.vat_input_account}%"), ~e.kt_account.like(f"{s.vat_input_account}%")), e.amount),
                    else_=0,
                )
            ),
        )
        .where(
            e.company_id.in_(company_ids),
            e.document_ref != "OPENING",
            e.date >= start_of(start),
            e.date < end_of(end),
        )
        .group_by(month)
    ).all()
    d = Document
    dmonth = func.date_trunc("month", d.date).label("month")
    invoiced = {
        f"{m:%Y-%m}": Decimal(v)
        for m, v in db.execute(
            select(dmonth, func.sum(d.vat))
            .where(
                d.company_id.in_(company_ids),
                d.type == "invoice_out",
                d.posted.is_(True),
                d.deleted.is_(False),
                d.date >= start_of(start),
                d.date < end_of(end),
            )
            .group_by(dmonth)
        )
    }
    result = {}
    for m, output, input_ in rows:
        key = f"{m:%Y-%m}"
        result[key] = {"month": key, "output": Decimal(output), "input": Decimal(input_)}
    for key in invoiced:
        result.setdefault(key, {"month": key, "output": ZERO, "input": ZERO})
    return [
        {
            "month": k,
            "output": str(v["output"]),
            "input": str(v["input"]),
            "payable": str(v["output"] - v["input"]),
            "invoiced": str(invoiced.get(k, ZERO)),
        }
        for k, v in sorted(result.items())
    ]


def trial_balance(db: Session, company_ids: list[int], start: date, end: date, account: str | None = None) -> list[dict]:
    """ОСВ: opening, turnover and closing per account (4-digit code)."""
    e = LedgerEntry
    sides = []
    for side, col in (("dt", e.dt_account), ("kt", e.kt_account)):
        sides.append(
            select(
                func.substr(col, 1, 4).label("account"),
                literal(side).label("side"),
                case((e.date < start_of(start), e.amount), else_=0).label("before"),
                case((e.date >= start_of(start), e.amount), else_=0).label("during"),
            ).where(e.company_id.in_(company_ids), e.date < end_of(end), col != "000")
        )
    u = union_all(*sides).subquery()
    q = select(
        u.c.account,
        func.sum(case((u.c.side == "dt", u.c.before), else_=0)),
        func.sum(case((u.c.side == "kt", u.c.before), else_=0)),
        func.sum(case((u.c.side == "dt", u.c.during), else_=0)),
        func.sum(case((u.c.side == "kt", u.c.during), else_=0)),
    ).group_by(u.c.account).order_by(u.c.account)
    if account:
        q = q.where(u.c.account.like(f"{account}%"))
    result = []
    for acc, open_dt, open_kt, turn_dt, turn_kt in db.execute(q):
        opening = Decimal(open_dt) - Decimal(open_kt)
        closing = opening + Decimal(turn_dt) - Decimal(turn_kt)
        result.append(
            {
                "account": acc,
                "opening_dt": str(max(opening, ZERO)),
                "opening_kt": str(max(-opening, ZERO)),
                "turnover_dt": str(Decimal(turn_dt)),
                "turnover_kt": str(Decimal(turn_kt)),
                "closing_dt": str(max(closing, ZERO)),
                "closing_kt": str(max(-closing, ZERO)),
            }
        )
    return result


def findings_by_severity(db: Session, company_ids: list[int]) -> dict:
    rows = db.execute(
        select(AuditFinding.severity, func.count())
        .where(AuditFinding.company_id.in_(company_ids), AuditFinding.status == "open")
        .group_by(AuditFinding.severity)
    ).all()
    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    counts.update({sev: n for sev, n in rows})
    return counts


def dashboard(db: Session, company_ids: list[int], on: date, start: date) -> dict:
    return {
        "cash_bank": cash_and_bank(db, company_ids, on),
        "receivables_payables": receivables_payables(db, company_ids, on),
        "aging": debt_aging(db, company_ids, on),
        "sales_purchases": sales_purchases(db, company_ids, start, on),
        "vat": vat_summary(db, company_ids, start, on),
        "findings": findings_by_severity(db, company_ids),
    }
