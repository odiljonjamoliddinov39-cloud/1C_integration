"""Schet-faktura entry (Function A).

draft (only in the app) -> creating (queued for the agent) -> created (unposted draft in 1C)
-> posting -> posted -> ready / sent -> signed | rejected

Nothing reaches 1C until the user clicks "Create in 1C"; a draft can be saved at any step.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Company, Counterparty, Invoice, Item, User, log_event
from app.services.agent_gateway import get_gateway
from app.services.einvoice import get_provider

CENT = Decimal("0.01")
VAT_RATES = (Decimal("0"), Decimal("12"), Decimal("15"))


class InvoiceError(Exception):
    def __init__(self, message: str, status: int = 400, errors: list | None = None):
        super().__init__(message)
        self.status = status
        self.errors = errors or []


def money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(CENT, rounding=ROUND_HALF_UP)


def compute_row(row: dict) -> dict:
    qty = Decimal(str(row.get("quantity") or 0))
    price = Decimal(str(row.get("price") or 0))
    rate = Decimal(str(row.get("vat_rate") or 0))
    amount = money(qty * price)
    vat = money(amount * rate / 100)
    return {**row, "quantity": str(qty), "price": str(price), "vat_rate": str(rate), "amount": str(amount), "vat": str(vat)}


def fill_rows_from_items(db: Session, company_id: int, rows: list[dict]) -> list[dict]:
    """Autofill unit, price, VAT rate and IKPU from `items` when the row leaves them empty."""
    refs = [r.get("item_ref") for r in rows if r.get("item_ref")]
    items = {
        i.ref_1c: i
        for i in db.scalars(select(Item).where(Item.company_id == company_id, Item.ref_1c.in_(refs)))
    }
    result = []
    for row in rows:
        item = items.get(row.get("item_ref"))
        row = dict(row)
        if item:
            if not row.get("name"):
                row["name"] = item.name
            if not row.get("unit"):
                row["unit"] = item.unit
            if row.get("price") in (None, ""):
                row["price"] = str(item.price)
            if row.get("vat_rate") in (None, "") and item.vat_rate is not None:
                row["vat_rate"] = str(item.vat_rate)
            if not row.get("ikpu_code"):
                row["ikpu_code"] = item.ikpu_code
        result.append(compute_row(row))
    return result


def recalc(invoice: Invoice) -> None:
    invoice.rows = [compute_row(r) for r in invoice.rows or []]
    invoice.vat = sum((Decimal(r["vat"]) for r in invoice.rows), Decimal("0"))
    invoice.total = sum((Decimal(r["amount"]) + Decimal(r["vat"]) for r in invoice.rows), Decimal("0"))


def validate(db: Session, invoice: Invoice) -> list[dict]:
    """Errors that block sending to 1C. Each is {"field", "message"} (row index when relevant)."""
    errors: list[dict] = []
    if not re.fullmatch(r"\d{9}", invoice.buyer_inn or ""):
        errors.append({"field": "buyer_inn", "message": "Buyer INN must be 9 digits"})
    buyer = None
    if invoice.buyer_ref:
        buyer = db.scalar(
            select(Counterparty).where(
                Counterparty.company_id == invoice.company_id, Counterparty.ref_1c == invoice.buyer_ref
            )
        )
    if buyer is None:
        errors.append({"field": "buyer_ref", "message": "Buyer is not a counterparty in 1C"})
    if not invoice.contract_ref:
        errors.append({"field": "contract_ref", "message": "Contract is required"})
    elif buyer is not None and invoice.contract_ref not in {c["ref"] for c in buyer.contract_refs or []}:
        errors.append({"field": "contract_ref", "message": "Contract does not belong to this buyer"})
    if not invoice.rows:
        errors.append({"field": "rows", "message": "Add at least one item"})

    item_refs = [r.get("item_ref") for r in invoice.rows or []]
    items = {
        i.ref_1c: i
        for i in db.scalars(select(Item).where(Item.company_id == invoice.company_id, Item.ref_1c.in_(item_refs)))
    }
    vat_total = Decimal("0")
    total = Decimal("0")
    for idx, row in enumerate(invoice.rows or []):
        where = {"row": idx + 1}
        item = items.get(row.get("item_ref"))
        if item is None:
            errors.append({**where, "field": "item_ref", "message": "Item not found in 1C"})
            continue
        if not (row.get("ikpu_code") or item.ikpu_code):
            errors.append({**where, "field": "ikpu_code", "message": f"«{item.name}» has no IKPU code"})
        qty = Decimal(str(row.get("quantity") or 0))
        if qty <= 0:
            errors.append({**where, "field": "quantity", "message": "Quantity must be positive"})
        rate = Decimal(str(row.get("vat_rate") or 0))
        if rate not in VAT_RATES:
            errors.append({**where, "field": "vat_rate", "message": "VAT rate must be 0, 12 or 15"})
        elif item.vat_rate is not None and rate != item.vat_rate:
            errors.append(
                {**where, "field": "vat_rate", "message": f"VAT {rate}% differs from the item's rate {item.vat_rate}%"}
            )
        amount = money(row.get("amount"))
        vat = money(row.get("vat"))
        if amount != money(qty * Decimal(str(row.get("price") or 0))):
            errors.append({**where, "field": "amount", "message": "Amount is not quantity × price"})
        if vat != money(amount * rate / 100):
            errors.append({**where, "field": "vat", "message": "VAT does not match the rate"})
        vat_total += vat
        total += amount + vat
    if invoice.rows and (money(invoice.total) != money(total) or money(invoice.vat) != money(vat_total)):
        errors.append({"field": "total", "message": "Totals do not add up"})
    return errors


def apply_input(db: Session, invoice: Invoice, data: dict) -> None:
    for key in ("date", "buyer_ref", "contract_ref"):
        if key in data and data[key] is not None:
            setattr(invoice, key, date.fromisoformat(data[key]) if key == "date" and isinstance(data[key], str) else data[key])
    if "buyer_ref" in data:
        buyer = db.scalar(
            select(Counterparty).where(
                Counterparty.company_id == invoice.company_id, Counterparty.ref_1c == data["buyer_ref"]
            )
        )
        invoice.buyer_inn = buyer.inn if buyer else data.get("buyer_inn", "")
        invoice.buyer_name = buyer.name if buyer else ""
    if "rows" in data:
        invoice.rows = fill_rows_from_items(db, invoice.company_id, data["rows"] or [])
    recalc(invoice)


def save_draft(db: Session, company: Company, user_id: int, data: dict, invoice: Invoice | None = None) -> Invoice:
    if invoice is None:
        invoice = Invoice(company_id=company.id, date=date.today(), rows=[], status="draft", created_by=user_id)
        db.add(invoice)
    elif invoice.status != "draft":
        raise InvoiceError("Only drafts can be edited; this invoice is already in 1C", 409)
    apply_input(db, invoice, data)
    db.flush()
    return invoice


def copy_as_template(db: Session, source: Invoice, user_id: int) -> Invoice:
    copy = Invoice(
        company_id=source.company_id,
        date=date.today(),
        buyer_ref=source.buyer_ref,
        buyer_inn=source.buyer_inn,
        buyer_name=source.buyer_name,
        contract_ref=source.contract_ref,
        rows=[{k: v for k, v in r.items()} for r in source.rows or []],
        status="draft",
        created_by=user_id,
    )
    recalc(copy)
    db.add(copy)
    db.flush()
    return copy


def send_to_1c(db: Session, invoice: Invoice, user_id: int) -> str:
    """Validate, issue an approval and queue POST /invoices on the agent."""
    if invoice.status != "draft":
        raise InvoiceError(f"Invoice is {invoice.status}, not a draft", 409)
    company = db.get(Company, invoice.company_id)
    if company.closed_period_until and invoice.date <= company.closed_period_until:
        raise InvoiceError("Invoice date is in a closed period", 409)
    errors = validate(db, invoice)
    if errors:
        raise InvoiceError("Invoice has validation errors", 422, errors)
    approval_id = str(uuid.uuid4())
    invoice.status = "creating"
    log_event(db, "invoice.create_requested", user_id=user_id, company_id=invoice.company_id,
              object_ref=invoice.id, approval_id=approval_id)
    db.commit()
    user = db.get(User, user_id)
    payload = {
        "approval_id": approval_id,
        "approved_by": user.email if user else str(user_id),
        "app_invoice_id": invoice.id,
        "date": invoice.date.isoformat(),
        "buyer_ref": invoice.buyer_ref,
        "contract_ref": invoice.contract_ref,
        "rows": [
            {k: r.get(k) for k in ("item_ref", "quantity", "price", "vat_rate", "amount", "vat")}
            for r in invoice.rows
        ],
        "total": str(invoice.total),
        "vat": str(invoice.vat),
    }
    return get_gateway().enqueue(
        invoice.company_id, "create_invoice", payload, callback="invoice_created", context={"invoice_id": invoice.id}
    )


def post_in_1c(db: Session, invoice: Invoice, user_id: int) -> str:
    if invoice.status != "created" or not invoice.ref_1c:
        raise InvoiceError("Only invoices created in 1C and not yet posted can be posted", 409)
    approval_id = str(uuid.uuid4())
    invoice.status = "posting"
    log_event(db, "invoice.post_requested", user_id=user_id, company_id=invoice.company_id,
              object_ref=invoice.ref_1c, approval_id=approval_id)
    db.commit()
    user = db.get(User, user_id)
    return get_gateway().enqueue(
        invoice.company_id,
        "post_invoice",
        {"approval_id": approval_id, "ref": invoice.ref_1c, "approved_by": user.email if user else str(user_id)},
        callback="invoice_posted",
        context={"invoice_id": invoice.id},
    )


def send_to_operator(db: Session, invoice: Invoice, user_id: int) -> Invoice:
    if invoice.status not in ("posted", "rejected"):
        raise InvoiceError("Post the invoice in 1C before sending it to the operator", 409)
    company = db.get(Company, invoice.company_id)
    result = get_provider().send(invoice, company)
    invoice.status = result.status
    invoice.operator_id = result.operator_id
    invoice.operator_message = result.message
    log_event(db, "invoice.sent_to_operator", user_id=user_id, company_id=invoice.company_id,
              object_ref=invoice.ref_1c, status=result.status)
    db.flush()
    return invoice


def handle_created(db: Session, invoice_id: int, reply: dict) -> Invoice:
    invoice = db.get(Invoice, invoice_id)
    if reply.get("ok"):
        data = reply["data"]
        invoice.ref_1c = data["ref"]
        invoice.number = data.get("number", "")
        invoice.status = "created"
        invoice.operator_message = ""
        # 1C recalculates totals; keep its numbers so the user reviews what is really in the base.
        if data.get("total") is not None:
            invoice.total = money(data["total"])
        if data.get("vat") is not None:
            invoice.vat = money(data["vat"])
        log_event(db, "invoice.created", company_id=invoice.company_id, object_ref=invoice.ref_1c, number=invoice.number)
    else:
        err = reply.get("error") or {}
        invoice.status = "draft"
        invoice.operator_message = f"1C refused: {err.get('message', 'error')}"
        log_event(db, "invoice.create_failed", company_id=invoice.company_id, object_ref=invoice.id, error=err)
    db.commit()
    return invoice


def handle_posted(db: Session, invoice_id: int, reply: dict) -> Invoice:
    invoice = db.get(Invoice, invoice_id)
    if reply.get("ok"):
        invoice.status = "posted"
        invoice.operator_message = ""
        log_event(db, "invoice.posted", company_id=invoice.company_id, object_ref=invoice.ref_1c)
    else:
        err = reply.get("error") or {}
        invoice.status = "created"
        invoice.operator_message = f"1C refused to post: {err.get('message', 'error')}"
        log_event(db, "invoice.post_failed", company_id=invoice.company_id, object_ref=invoice.ref_1c, error=err)
    invoice.updated_at = datetime.now(timezone.utc)
    db.commit()
    return invoice
