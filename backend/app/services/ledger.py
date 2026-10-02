"""Calculations over mirrored journal entries, shared by audit rules and analytics."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from datetime import date
from decimal import Decimal

from app.models import LedgerEntry

ZERO = Decimal("0")


def matches(account: str, prefix: str) -> bool:
    return account.startswith(prefix)


def daily_balances(entries: Iterable[LedgerEntry], prefix: str) -> list[tuple[date, Decimal, list[str]]]:
    """Closing balance (debit minus credit) of accounts starting with `prefix`, per day with movement.

    Returns [(day, closing_balance, [document_refs moving that day])], ordered by day.
    """
    per_day: dict[date, Decimal] = defaultdict(lambda: ZERO)
    docs: dict[date, list[str]] = defaultdict(list)
    for e in entries:
        delta = ZERO
        if matches(e.dt_account, prefix):
            delta += e.amount
        if matches(e.kt_account, prefix):
            delta -= e.amount
        if delta:
            day = e.date.date()
            per_day[day] += delta
            if e.document_ref not in docs[day]:
                docs[day].append(e.document_ref)
    result = []
    balance = ZERO
    for day in sorted(per_day):
        balance += per_day[day]
        result.append((day, balance, docs[day]))
    return result


def _side_counterparty(entry: LedgerEntry, side: str) -> str | None:
    return ((entry.subconto_json or {}).get(side) or {}).get("counterparty_ref")


def open_lots(
    entries: Iterable[LedgerEntry], prefix: str, as_of: date | None = None, debit_side: bool = True
) -> dict[str, list[list]]:
    """FIFO open items per counterparty on settlement accounts.

    For receivables (`debit_side=True`, accounts 40xx) a debit opens a lot and a credit pays off
    the oldest lots. For payables (60xx) it is the other way round. Overpayments are kept as a
    negative lot (advance). Returns {counterparty_ref: [[date, remaining_amount, document_ref], ...]}.
    """
    lots: dict[str, list[list]] = defaultdict(list)
    for e in entries:
        day = e.date.date()
        if as_of and day > as_of:
            continue
        for side, sign in (("dt", 1), ("kt", -1)):
            account = e.dt_account if side == "dt" else e.kt_account
            if not matches(account, prefix):
                continue
            cp = _side_counterparty(e, side) or "unknown"
            increases = (sign == 1) == debit_side
            if increases:
                queue = lots[cp]
                # An existing advance (negative lot) absorbs a new debt first.
                amount = e.amount
                while amount > 0 and queue and queue[0][1] < 0:
                    take = min(amount, -queue[0][1])
                    queue[0][1] += take
                    amount -= take
                    if queue[0][1] == 0:
                        queue.pop(0)
                if amount > 0:
                    queue.append([day, amount, e.document_ref])
            else:
                remaining = e.amount
                queue = lots[cp]
                while remaining > 0 and queue and queue[0][1] > 0:
                    take = min(remaining, queue[0][1])
                    queue[0][1] -= take
                    remaining -= take
                    if queue[0][1] == 0:
                        queue.pop(0)
                if remaining > 0:
                    queue.append([day, -remaining, e.document_ref])
    return {cp: q for cp, q in lots.items() if q}


AGING_BUCKETS = (("0-30", 0, 30), ("31-60", 31, 60), ("61-90", 61, 90), ("90+", 91, 10**6))


def aging(lots: dict[str, list[list]], as_of: date) -> dict[str, dict[str, Decimal]]:
    result: dict[str, dict[str, Decimal]] = {}
    for cp, queue in lots.items():
        buckets = {name: ZERO for name, _, _ in AGING_BUCKETS}
        for day, amount, _ in queue:
            if amount <= 0:
                continue
            age = (as_of - day).days
            for name, lo, hi in AGING_BUCKETS:
                if lo <= age <= hi:
                    buckets[name] += amount
                    break
        if any(buckets.values()):
            result[cp] = buckets
    return result


def stock_movements(entries: Iterable[LedgerEntry], prefixes: list[str]):
    """Running quantity per (item_ref, warehouse_ref) on inventory accounts.

    Yields (key, day, running_quantity, document_ref) in date order.
    """
    running: dict[tuple[str, str], Decimal] = defaultdict(lambda: ZERO)
    for e in entries:
        for side, sign in (("dt", 1), ("kt", -1)):
            account = e.dt_account if side == "dt" else e.kt_account
            if not any(matches(account, p) for p in prefixes):
                continue
            sub = (e.subconto_json or {}).get(side) or {}
            qty = sub.get("quantity")
            if qty in (None, "") or not sub.get("item_ref"):
                continue
            key = (sub["item_ref"], sub.get("warehouse_ref") or "")
            running[key] += Decimal(str(qty)) * sign
            yield key, e.date.date(), running[key], e.document_ref
