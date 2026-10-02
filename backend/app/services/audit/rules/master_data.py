import re

from app.services.audit.engine import HIGH, MEDIUM, AuditContext, FixType, Hit, rule

INN_RE = re.compile(r"^(\d{9}|\d{14})$")
SALE_TYPES = ("sale", "invoice_out")


@rule("NO-INN", MEDIUM, FixType.FILL_FIELD, "Counterparty without INN, or INN not 9 or 14 digits")
def counterparty_inn(ctx: AuditContext) -> list[Hit]:
    hits = []
    for cp in ctx.counterparties:
        if INN_RE.match(cp.inn or ""):
            continue
        problem = "без ИНН" if not cp.inn else f"с неверным ИНН «{cp.inn}» (нужно 9 или 14 цифр)"
        hits.append(
            Hit(
                object_ref=cp.ref_1c,
                object_type="counterparty",
                message=f"Контрагент «{cp.name}» {problem}",
                details={"field": "inn", "current": cp.inn, "name": cp.name},
            )
        )
    return hits


@rule("NO-IKPU", HIGH, FixType.FILL_FIELD, "Sold item without an IKPU code")
def item_without_ikpu(ctx: AuditContext) -> list[Hit]:
    sold: dict[str, list[str]] = {}
    for d in ctx.documents:
        if d.type in SALE_TYPES:
            for row in (d.raw_json or {}).get("rows", []):
                ref = row.get("item_ref")
                if ref:
                    sold.setdefault(ref, []).append(d.ref_1c)
    hits = []
    for ref, docs in sold.items():
        item = ctx.items.get(ref)
        if item is None or item.ikpu_code:
            continue
        hits.append(
            Hit(
                object_ref=item.ref_1c,
                object_type="item",
                message=f"Номенклатура «{item.name}» продаётся без кода ИКПУ ({len(set(docs))} док.)",
                details={"field": "ikpu_code", "current": "", "name": item.name, "documents": sorted(set(docs))[:50]},
                fingerprint_data={"ikpu": item.ikpu_code},
            )
        )
    return hits
