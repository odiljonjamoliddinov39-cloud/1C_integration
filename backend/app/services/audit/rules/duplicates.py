from collections import defaultdict

from app.services.audit.engine import HIGH, MEDIUM, AuditContext, FixType, Hit, rule


@rule("DUP-DOC", HIGH, FixType.REVERSE_DUPLICATE, "Same counterparty, amount and date on two documents")
def duplicate_documents(ctx: AuditContext) -> list[Hit]:
    groups = defaultdict(list)
    for d in ctx.documents:
        if d.posted and d.counterparty_ref and d.amount > 0:
            groups[(d.type, d.counterparty_ref, d.amount, d.date.date())].append(d)
    hits = []
    for (_, _, amount, _), docs in groups.items():
        if len(docs) < 2:
            continue
        original, *duplicates = sorted(docs, key=lambda d: (d.date, d.number))
        for dup in duplicates:
            hits.append(
                Hit(
                    object_ref=dup.ref_1c,
                    object_date=dup.date,
                    amount=amount,
                    message=(
                        f"{ctx.doc_label(dup)} повторяет {ctx.doc_label(original)}: "
                        f"тот же контрагент, сумма {amount:,.2f} и дата"
                    ),
                    details={
                        "document_type": dup.type,
                        "original_ref": original.ref_1c,
                        "original_number": original.number,
                        "counterparty_ref": dup.counterparty_ref,
                    },
                )
            )
    return hits


@rule("DUP-CP", MEDIUM, FixType.MERGE_COUNTERPARTIES, "Two counterparties with the same INN")
def duplicate_counterparties(ctx: AuditContext) -> list[Hit]:
    usage = defaultdict(int)
    for d in ctx.documents:
        if d.counterparty_ref:
            usage[d.counterparty_ref] += 1
    groups = defaultdict(list)
    for cp in ctx.counterparties:
        if cp.inn:
            groups[cp.inn].append(cp)
    hits = []
    for inn, cps in groups.items():
        if len(cps) < 2:
            continue
        # The main record is the one most documents already point to.
        main, *dups = sorted(cps, key=lambda c: (-usage[c.ref_1c], c.name, c.ref_1c))
        for dup in dups:
            hits.append(
                Hit(
                    object_ref=dup.ref_1c,
                    object_type="counterparty",
                    message=(
                        f"Контрагенты «{dup.name}» и «{main.name}» имеют один ИНН {inn}; "
                        f"документов на дубле: {usage[dup.ref_1c]}"
                    ),
                    details={
                        "inn": inn,
                        "main_ref": main.ref_1c,
                        "main_name": main.name,
                        "duplicate_name": dup.name,
                        "documents_on_duplicate": usage[dup.ref_1c],
                    },
                    fingerprint_data={"inn": inn, "main": main.ref_1c, "dup": dup.ref_1c},
                )
            )
    return hits
