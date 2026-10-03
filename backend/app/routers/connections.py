"""Owner-only: connect a company to its 1C base directly by address, username and password.

The form in Admin -> Companies -> Connect 1C calls `test` first (nothing is saved), then
`connection` to save it and start a full sync. `companies/connect` creates the company from the
organization 1C reports, so a new base is one form.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_owner
from app.models import Company, OneCConnection, User, log_event, utcnow
from app.routers.common import company_out
from app.security import decrypt_secret, encrypt_secret
from app.services import odata
from app.services.agent_gateway import get_gateway
from app.services.connections import base_path_for, describe

router = APIRouter(prefix="/api/admin", tags=["admin"])


class ConnectionIn(BaseModel):
    address: str  # 192.168.1.10, server:8080, or a full http(s)://... URL
    base: str = ""  # publication name, e.g. TEST_CRYSTAL (optional if part of the address)
    username: str
    password: str = ""  # empty: keep the stored password (when editing a connection)
    company_id: int | None = None


class NewCompanyIn(ConnectionIn):
    organization_ref: str | None = None
    name: str | None = None


def _transport():
    factory = getattr(get_gateway(), "transport_factory", None)
    return factory(None) if factory else None


def _url(body: ConnectionIn) -> str:
    try:
        return odata.odata_url(body.address, body.base)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def _password(db: Session, body: ConnectionIn) -> str:
    if body.password:
        return body.password
    stored = db.get(OneCConnection, body.company_id) if body.company_id else None
    if stored is None:
        raise HTTPException(400, "Enter the 1C password")
    try:
        return decrypt_secret(stored.password_enc)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def _tested(db: Session, body: ConnectionIn) -> tuple[str, str, dict]:
    url = _url(body)
    password = _password(db, body)
    result = odata.test_connection(url, body.username, password, transport=_transport())
    return url, password, result


@router.post("/onec/test")
def test_connection(body: ConnectionIn, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    """Try the address and login. Nothing is saved."""
    return _tested(db, body)[2]


@router.get("/companies/{company_id}/connection")
def get_connection(company_id: int, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    company = db.get(Company, company_id)
    if not company:
        raise HTTPException(404, "Company not found")
    return {"connection_type": company.connection_type, "direct": describe(company, db.get(OneCConnection, company_id))}


def _save(db: Session, owner: User, company: Company, url: str, username: str, password: str, result: dict) -> dict:
    if not result["ok"]:
        raise HTTPException(400, result.get("error") or "Connection failed")
    inns = {o["inn"] for o in result["organizations"] if o["inn"]}
    if company.inn and inns and company.inn not in inns:
        raise HTTPException(
            409,
            f"This 1C base belongs to INN {', '.join(sorted(inns))}, not {company.inn}. Check the base name.",
        )
    if not company.inn and len(inns) == 1:
        company.inn = next(iter(inns))
    conn = db.get(OneCConnection, company.id) or OneCConnection(company_id=company.id)
    conn.url, conn.username, conn.password_enc = url, username, encrypt_secret(password)
    conn.last_error, conn.last_ok_at, conn.updated_at = None, utcnow(), utcnow()
    db.add(conn)
    company.connection_type = "odata"
    company.base_path = base_path_for(url)
    company.base_error = None
    company.sync_cursor = None  # cursors of the two transports differ: start with a full sync
    log_event(db, "admin.onec_connected", user_id=owner.id, company_id=company.id, url=url, username=username)
    db.commit()
    _after_change(company.id)
    from app.jobs import enqueue, sync_company

    enqueue(sync_company, company.id, True)
    db.expire_all()
    return {**company_out(company), "direct": describe(company, conn), "test": result}


def _after_change(company_id: int) -> None:
    from app.services.onec import forget_verification

    forget_verification(company_id)
    forget = getattr(get_gateway(), "forget", None)
    if forget:
        forget(company_id)


@router.post("/companies/{company_id}/connection")
def save_connection(company_id: int, body: ConnectionIn, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    """Test, then save the direct connection and start a full sync."""
    company = db.get(Company, company_id)
    if not company:
        raise HTTPException(404, "Company not found")
    body.company_id = company_id
    url, password, result = _tested(db, body)
    return _save(db, owner, company, url, body.username, password, result)


@router.post("/companies/connect")
def create_from_1c(body: NewCompanyIn, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    """Create a company from the organization in a 1C base, connected directly."""
    url, password, result = _tested(db, body)
    if not result["ok"]:
        raise HTTPException(400, result.get("error") or "Connection failed")
    orgs = result["organizations"]
    org = next((o for o in orgs if o["ref"] == body.organization_ref), orgs[0] if orgs else None)
    name = (body.name or "").strip() or (org["name"] if org else "") or odata.publication_name(url)
    company = Company(name=name, inn=org["inn"] if org else "")
    db.add(company)
    db.flush()
    log_event(db, "admin.company_created", user_id=owner.id, company_id=company.id)
    return _save(db, owner, company, url, body.username, password, result)


@router.delete("/companies/{company_id}/connection")
def remove_connection(company_id: int, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    """Back to the agent: the stored address and password are deleted."""
    company = db.get(Company, company_id)
    if not company:
        raise HTTPException(404, "Company not found")
    conn = db.get(OneCConnection, company_id)
    if conn:
        db.delete(conn)
    company.connection_type = "agent"
    company.sync_cursor = None
    log_event(db, "admin.onec_disconnected", user_id=owner.id, company_id=company_id)
    db.commit()
    _after_change(company_id)
    return company_out(company)
