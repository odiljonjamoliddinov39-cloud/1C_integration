from datetime import datetime

from app.services.audit.engine import HIGH, AuditContext, Hit, rule
from app.services.ledger import stock_movements


@rule("NEG-STOCK", HIGH, None, "Item quantity below zero at a warehouse")
def negative_stock(ctx: AuditContext) -> list[Hit]:
    first_negative: dict = {}
    lowest: dict = {}
    for key, day, qty, doc_ref in stock_movements(ctx.entries, ctx.settings.inventory_prefixes):
        if qty < 0:
            first_negative.setdefault(key, (day, doc_ref))
            lowest[key] = min(lowest.get(key, qty), qty)
    hits = []
    for (item_ref, warehouse_ref), (day, doc_ref) in first_negative.items():
        item = ctx.items.get(item_ref)
        name = item.name if item else item_ref
        hits.append(
            Hit(
                object_ref=f"{item_ref}:{warehouse_ref}",
                object_type="item",
                object_date=datetime.combine(day, datetime.min.time()),
                message=(
                    f"Остаток «{name}» на складе ушёл в минус {day:%d.%m.%Y} "
                    f"(минимум {lowest[(item_ref, warehouse_ref)]})"
                ),
                details={
                    "item_ref": item_ref,
                    "warehouse_ref": warehouse_ref,
                    "first_document": doc_ref,
                    "min_quantity": str(lowest[(item_ref, warehouse_ref)]),
                },
                fingerprint_data={"day": day.isoformat(), "min": str(lowest[(item_ref, warehouse_ref)])},
            )
        )
    return hits
