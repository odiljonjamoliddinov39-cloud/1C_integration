from datetime import datetime
from decimal import Decimal

from app.services.audit.engine import MEDIUM, AuditContext, Hit, rule
from app.services.ledger import open_lots

OVERDUE_DAYS = 90


@rule("OLD-DEBT", MEDIUM, None, "Receivable older than 90 days")
def old_receivables(ctx: AuditContext) -> list[Hit]:
    names = {cp.ref_1c: cp.name for cp in ctx.counterparties}
    lots = open_lots(ctx.entries, ctx.settings.receivable_prefix, as_of=ctx.today, debit_side=True)
    hits = []
    for cp_ref, queue in lots.items():
        overdue = [lot for lot in queue if lot[1] > 0 and (ctx.today - lot[0]).days > OVERDUE_DAYS]
        if not overdue:
            continue
        total = sum((lot[1] for lot in overdue), Decimal("0"))
        oldest = overdue[0][0]
        hits.append(
            Hit(
                object_ref=cp_ref,
                object_type="counterparty",
                object_date=datetime.combine(oldest, datetime.min.time()),
                amount=total,
                message=(
                    f"«{names.get(cp_ref, cp_ref)}» должен {total:,.2f} UZS дольше {OVERDUE_DAYS} дней "
                    f"(самый старый долг с {oldest:%d.%m.%Y})"
                ),
                details={
                    "counterparty_ref": cp_ref,
                    "lots": [
                        {"date": d.isoformat(), "amount": str(a), "document_ref": ref} for d, a, ref in overdue
                    ][:50],
                },
                fingerprint_data={"total": str(total), "oldest": oldest.isoformat()},
            )
        )
    return hits
