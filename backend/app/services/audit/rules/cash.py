from datetime import datetime

from app.services.audit.engine import CRITICAL, AuditContext, Hit, rule
from app.services.ledger import daily_balances


@rule("CASH-NEG", CRITICAL, None, "Cash (5010) balance below zero on any day")
def cash_negative(ctx: AuditContext) -> list[Hit]:
    """One finding per run of consecutive negative days (a "streak")."""
    hits: list[Hit] = []
    streak: list = []

    def close_streak():
        if not streak:
            return
        start = streak[0][0]
        lowest = min(b for _, b, _ in streak)
        docs = [d for _, _, refs in streak for d in refs if d != "OPENING"]
        hits.append(
            Hit(
                object_ref=f"cash:{start.isoformat()}",
                object_type="account",
                object_date=datetime.combine(start, datetime.min.time()),
                amount=lowest,
                message=(
                    f"Касса {ctx.settings.cash_account} ушла в минус {start:%d.%m.%Y}: "
                    f"минимальный остаток {lowest:,.2f} UZS, дней в минусе: {len(streak)}"
                ),
                details={
                    "account": ctx.settings.cash_account,
                    "days": [{"date": d.isoformat(), "balance": str(b)} for d, b, _ in streak][:31],
                    "documents": docs[:50],
                },
                fingerprint_data=[(d.isoformat(), str(b)) for d, b, _ in streak],
            )
        )
        streak.clear()

    for day, balance, refs in daily_balances(ctx.entries, ctx.settings.cash_account):
        if balance < 0:
            streak.append((day, balance, refs))
        else:
            close_streak()
    close_streak()
    return hits
