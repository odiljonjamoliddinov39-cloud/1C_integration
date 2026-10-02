from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from app.services.audit.engine import HIGH, LOW, AuditContext, FixType, Hit, rule
from app.services.ledger import matches

# Счета-фактуры are registers of VAT documents and make no settlement entries of their own.
NO_ENTRY_TYPES = ("invoice_out", "invoice_in")
CONTRACT_TYPES = ("sale", "purchase", "invoice_out", "invoice_in")


@rule("UNPOSTED", LOW, None, "Document older than 3 days still unposted")
def unposted(ctx: AuditContext) -> list[Hit]:
    limit = ctx.today - timedelta(days=3)
    return [
        Hit(
            object_ref=d.ref_1c,
            object_date=d.date,
            amount=d.amount,
            message=f"{ctx.doc_label(d)} не проведён уже {(ctx.today - d.date.date()).days} дн.",
            details={"document_type": d.type},
            fingerprint_data={"posted": d.posted},
        )
        for d in ctx.documents
        if not d.posted and d.date.date() < limit
    ]


@rule("ENTRY-MISMATCH", HIGH, FixType.REPOST, "Document total differs from the sum of its ledger entries")
def entry_mismatch(ctx: AuditContext) -> list[Hit]:
    """Compares the document total with its entries that touch settlement accounts (40, 50, 51, 60).

    Each entry counts once even when both sides are settlement accounts (e.g. Дт 5110 Кт 4010).
    """
    sums: dict[str, Decimal] = defaultdict(Decimal)
    for e in ctx.entries:
        if any(matches(e.dt_account, p) or matches(e.kt_account, p) for p in ctx.settings.settlement_prefixes):
            sums[e.document_ref] += e.amount
    hits = []
    for d in ctx.documents:
        if not d.posted or d.amount <= 0 or d.type in NO_ENTRY_TYPES:
            continue
        posted_sum = sums.get(d.ref_1c, Decimal("0"))
        if abs(posted_sum - d.amount) > Decimal("0.01"):
            hits.append(
                Hit(
                    object_ref=d.ref_1c,
                    object_date=d.date,
                    amount=d.amount - posted_sum,
                    message=(
                        f"{ctx.doc_label(d)}: сумма документа {d.amount:,.2f}, "
                        f"по проводкам {posted_sum:,.2f}"
                    ),
                    details={
                        "document_type": d.type,
                        "document_amount": str(d.amount),
                        "entries_amount": str(posted_sum),
                    },
                )
            )
    return hits


@rule("NO-CONTRACT", LOW, FixType.FILL_FIELD, "Document without a contract")
def no_contract(ctx: AuditContext) -> list[Hit]:
    contracts_by_cp = {cp.ref_1c: cp.contract_refs or [] for cp in ctx.counterparties}
    hits = []
    for d in ctx.documents:
        if d.type in CONTRACT_TYPES and d.counterparty_ref and not d.contract_ref:
            options = contracts_by_cp.get(d.counterparty_ref, [])
            hits.append(
                Hit(
                    object_ref=d.ref_1c,
                    object_date=d.date,
                    amount=d.amount,
                    message=f"{ctx.doc_label(d)} без договора",
                    details={
                        "document_type": d.type,
                        "field": "contract_ref",
                        "current": None,
                        "counterparty_ref": d.counterparty_ref,
                        # Only one contract with this counterparty: the fix can suggest it.
                        "suggested": options[0]["ref"] if len(options) == 1 else None,
                    },
                )
            )
    return hits
