"""Schet-faktura entry (A)."""

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import check_company, get_current_user, require_writer, resolve_companies
from app.models import Invoice, User, log_event
from app.routers.common import XLSX, invoice_out
from app.services import excel
from app.services import invoices as service

router = APIRouter(prefix="/api/invoices", tags=["invoices"])


def _invoice(db: Session, user: User, invoice_id: int) -> Invoice:
    invoice = db.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(404, "Invoice not found")
    check_company(db, user, invoice.company_id)
    return invoice


def _raise(e: service.InvoiceError):
    raise HTTPException(e.status, {"message": str(e), "errors": e.errors}) from e


class InvoiceIn(BaseModel):
    company_id: int | None = None
    date: str | None = None
    buyer_ref: str | None = None
    contract_ref: str | None = None
    rows: list[dict] | None = None


@router.get("")
def list_invoices(
    company_id: int | None = None, status: str | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    ids = resolve_companies(db, user, company_id)
    q = select(Invoice).where(Invoice.company_id.in_(ids))
    if status:
        q = q.where(Invoice.status.in_(status.split(",")))
    return [invoice_out(i) for i in db.scalars(q.order_by(Invoice.id.desc()).limit(500))]


@router.post("")
def create_draft(body: InvoiceIn, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    if body.company_id is None:
        raise HTTPException(400, "company_id is required")
    company = check_company(db, user, body.company_id)
    invoice = service.save_draft(db, company, user.id, body.model_dump(exclude_unset=True, exclude={"company_id"}))
    db.commit()
    return invoice_out(invoice, service.validate(db, invoice))


@router.get("/bulk/template.xlsx")
def bulk_template(user: User = Depends(get_current_user)):
    return Response(excel.bulk_template(), media_type=XLSX, headers={"Content-Disposition": 'attachment; filename="invoices-template.xlsx"'})


@router.post("/bulk/preview")
async def bulk_preview(company_id: int, file: UploadFile = File(...), user: User = Depends(require_writer), db: Session = Depends(get_db)):
    company = check_company(db, user, company_id)
    try:
        return excel.parse_bulk(db, company, await file.read())
    except service.InvoiceError as e:
        _raise(e)


class BulkCreateIn(BaseModel):
    company_id: int
    invoices: list[InvoiceIn]
    send_to_1c: bool = True


@router.post("/bulk/create")
def bulk_create(body: BulkCreateIn, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    """Create drafts from the previewed invoices; valid ones are sent to 1C right away."""
    company = check_company(db, user, body.company_id)
    results = []
    for item in body.invoices:
        invoice = service.save_draft(db, company, user.id, item.model_dump(exclude_unset=True, exclude={"company_id"}))
        db.commit()
        errors = service.validate(db, invoice)
        if body.send_to_1c and not errors:
            try:
                service.send_to_1c(db, invoice, user.id)
            except service.InvoiceError as e:
                errors = e.errors or [{"message": str(e)}]
        db.expire_all()
        results.append(invoice_out(db.get(Invoice, invoice.id), errors))
    log_event(db, "invoice.bulk_created", user_id=user.id, company_id=company.id, count=len(results))
    db.commit()
    return results


@router.get("/{invoice_id}")
def get_invoice(invoice_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    invoice = _invoice(db, user, invoice_id)
    return invoice_out(invoice, service.validate(db, invoice) if invoice.status == "draft" else None)


@router.put("/{invoice_id}")
def update_draft(invoice_id: int, body: InvoiceIn, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    invoice = _invoice(db, user, invoice_id)
    try:
        service.save_draft(db, None, user.id, body.model_dump(exclude_unset=True, exclude={"company_id"}), invoice)
    except service.InvoiceError as e:
        _raise(e)
    db.commit()
    return invoice_out(invoice, service.validate(db, invoice))


@router.delete("/{invoice_id}")
def delete_draft(invoice_id: int, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    invoice = _invoice(db, user, invoice_id)
    if invoice.status != "draft":
        raise HTTPException(409, "Only drafts can be deleted")
    db.delete(invoice)
    db.commit()
    return {"ok": True}


@router.post("/{invoice_id}/copy")
def copy_invoice(invoice_id: int, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    copy = service.copy_as_template(db, _invoice(db, user, invoice_id), user.id)
    db.commit()
    return invoice_out(copy, service.validate(db, copy))


@router.post("/{invoice_id}/create-in-1c")
def create_in_1c(invoice_id: int, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    invoice = _invoice(db, user, invoice_id)
    try:
        service.send_to_1c(db, invoice, user.id)
    except service.InvoiceError as e:
        _raise(e)
    db.expire_all()
    return invoice_out(db.get(Invoice, invoice_id))


@router.post("/{invoice_id}/post")
def post_invoice(invoice_id: int, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    invoice = _invoice(db, user, invoice_id)
    try:
        service.post_in_1c(db, invoice, user.id)
    except service.InvoiceError as e:
        _raise(e)
    db.expire_all()
    return invoice_out(db.get(Invoice, invoice_id))


@router.post("/{invoice_id}/send")
def send_invoice(invoice_id: int, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    invoice = _invoice(db, user, invoice_id)
    try:
        service.send_to_operator(db, invoice, user.id)
    except service.InvoiceError as e:
        _raise(e)
    db.commit()
    return invoice_out(invoice)
