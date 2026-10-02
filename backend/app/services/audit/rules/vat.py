from collections import defaultdict
from datetime import datetime
from decimal import Decimal

from app.services.audit.engine import CRITICAL, HIGH, AuditContext, FixType, Hit, pct, rule
from app.services.ledger import matches

VAT_DOC_TYPES = ("sale", "purchase", "invoice_out", "invoice_in")
TOLERANCE = Decimal("1.00")


@rule("VAT-RATE", HIGH, FixType.CORRECT_VAT, "Row VAT differs from the item's VAT rate")
def row_vat_rate(ctx: AuditContext) -> list[Hit]:
    hits = []
    for d in ctx.documents:
        if d.type not in VAT_DOC_TYPES:
            continue
        wrong = []
        for idx, row in enumerate((d.raw_json or {}).get("rows", [])):
            item = ctx.items.get(row.get("item_ref"))
            if item is None or item.vat_rate is None or row.get("vat_rate") is None:
                continue
            if Decimal(str(row["vat_rate"])) != item.vat_rate:
                wrong.append(
                    {
                        "row": idx + 1,
                        "item_ref": item.ref_1c,
                        "item_name": item.name,
                        "row_rate": str(row["vat_rate"]),
                        "item_rate": str(item.vat_rate),
                    }
                )
        if wrong:
            names = ", ".join(f"«{w['item_name']}» {pct(w['row_rate'])}% вместо {pct(w['item_rate'])}%" for w in wrong[:3])
            hits.append(
                Hit(
                    object_ref=d.ref_1c,
                    object_date=d.date,
                    amount=d.vat,
                    message=f"{ctx.doc_label(d)}: ставка НДС в строках не совпадает с номенклатурой ({names})",
                    details={"document_type": d.type, "rows": wrong},
                )
            )
    return hits


@rule("VAT-MISMATCH", CRITICAL, None, "Invoices' VAT total differs from the VAT ledger for the month")
def vat_mismatch(ctx: AuditContext) -> list[Hit]:
    invoices: dict[str, Decimal] = defaultdict(Decimal)
    for d in ctx.documents:
        if d.type == "invoice_out" and d.posted:
            invoices[f"{d.date:%Y-%m}"] += d.vat
    ledger: dict[str, Decimal] = defaultdict(Decimal)
    for e in ctx.entries:
        if e.document_ref == "OPENING":
            continue
        # Output VAT accrued in the month = credit turnover of 6410. Debits (offset of input VAT,
        # payments to the budget) are settlements of that VAT, not accruals, so they are excluded.
        if matches(e.kt_account, ctx.settings.vat_output_account) and not matches(
            e.dt_account, ctx.settings.vat_output_account
        ):
            ledger[f"{e.date:%Y-%m}"] += e.amount
    hits = []
    current_month = f"{ctx.today:%Y-%m}"
    for month in sorted(set(invoices) | set(ledger)):
        if month == current_month:
            continue  # the month is still open; invoices are often issued after shipment
        diff = invoices[month] - ledger[month]
        if abs(diff) > TOLERANCE:
            hits.append(
                Hit(
                    object_ref=f"month:{month}",
                    object_type="period",
                    object_date=datetime.strptime(month + "-01", "%Y-%m-%d"),
                    amount=diff,
                    message=(
                        f"{month}: НДС по счетам-фактурам {invoices[month]:,.2f}, "
                        f"по счёту {ctx.settings.vat_output_account} {ledger[month]:,.2f}, "
                        f"разница {diff:,.2f} UZS"
                    ),
                    details={
                        "month": month,
                        "invoices_vat": str(invoices[month]),
                        "ledger_vat": str(ledger[month]),
                        "difference": str(diff),
                    },
                )
            )
    return hits
