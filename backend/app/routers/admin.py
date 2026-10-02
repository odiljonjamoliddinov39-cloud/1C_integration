"""Owner-only management of users, companies and agent tokens."""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_owner
from app.models import Agent, Company, Role, User, UserCompany, log_event
from app.routers.common import company_out, iso, user_out
from app.security import hash_password, hash_token, new_token

router = APIRouter(prefix="/api/admin", tags=["admin"])


class UserIn(BaseModel):
    email: EmailStr
    name: str = ""
    password: str | None = None
    role: str = Role.VIEWER
    is_active: bool = True
    company_ids: list[int] = []


def _user_companies(db: Session, user_id: int) -> list[int]:
    return list(db.scalars(select(UserCompany.company_id).where(UserCompany.user_id == user_id)))


def _set_companies(db: Session, user: User, company_ids: list[int]) -> None:
    db.execute(delete(UserCompany).where(UserCompany.user_id == user.id))
    for cid in set(company_ids):
        if db.get(Company, cid) is None:
            raise HTTPException(404, f"Company {cid} not found")
        db.add(UserCompany(user_id=user.id, company_id=cid))


@router.get("/users")
def list_users(owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    return [user_out(u, _user_companies(db, u.id)) for u in db.scalars(select(User).order_by(User.id))]


@router.post("/users")
def create_user(body: UserIn, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    if body.role not in Role.ALL:
        raise HTTPException(400, "Unknown role")
    if not body.password or len(body.password) < 10:
        raise HTTPException(400, "Password must be at least 10 characters")
    if db.scalar(select(User).where(User.email == body.email.lower())):
        raise HTTPException(409, "Email already used")
    user = User(email=body.email.lower(), name=body.name, password_hash=hash_password(body.password), role=body.role, is_active=body.is_active)
    db.add(user)
    db.flush()
    _set_companies(db, user, body.company_ids)
    log_event(db, "admin.user_created", user_id=owner.id, object_ref=user.id, role=user.role)
    db.commit()
    return user_out(user, _user_companies(db, user.id))


@router.put("/users/{user_id}")
def update_user(user_id: int, body: UserIn, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if body.role not in Role.ALL:
        raise HTTPException(400, "Unknown role")
    if user.id == owner.id and (body.role != Role.OWNER or not body.is_active):
        raise HTTPException(400, "You cannot demote or disable yourself")
    user.email, user.name, user.role, user.is_active = body.email.lower(), body.name, body.role, body.is_active
    if body.password:
        if len(body.password) < 10:
            raise HTTPException(400, "Password must be at least 10 characters")
        user.password_hash = hash_password(body.password)
    _set_companies(db, user, body.company_ids)
    log_event(db, "admin.user_updated", user_id=owner.id, object_ref=user.id, role=user.role)
    db.commit()
    return user_out(user, _user_companies(db, user.id))


class CompanyIn(BaseModel):
    name: str
    inn: str = ""
    base_path: str = ""
    closed_period_until: date | None = None


@router.post("/companies")
def create_company(body: CompanyIn, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    company = Company(**body.model_dump())
    db.add(company)
    db.flush()
    log_event(db, "admin.company_created", user_id=owner.id, company_id=company.id)
    db.commit()
    return company_out(company)


@router.put("/companies/{company_id}")
def update_company(company_id: int, body: CompanyIn, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    company = db.get(Company, company_id)
    if not company:
        raise HTTPException(404, "Company not found")
    for k, v in body.model_dump().items():
        setattr(company, k, v)
    log_event(db, "admin.company_updated", user_id=owner.id, company_id=company.id)
    db.commit()
    return company_out(company)


@router.get("/companies/{company_id}/agents")
def list_agents(company_id: int, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    return [
        {"id": a.id, "last_seen": iso(a.last_seen), "version": a.version, "revoked": a.revoked, "created_at": iso(a.created_at)}
        for a in db.scalars(select(Agent).where(Agent.company_id == company_id).order_by(Agent.id))
    ]


@router.post("/companies/{company_id}/agents")
def issue_agent_token(company_id: int, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    """One token per company: issuing a new one revokes the previous ones. Shown once."""
    if not db.get(Company, company_id):
        raise HTTPException(404, "Company not found")
    for old in db.scalars(select(Agent).where(Agent.company_id == company_id, Agent.revoked.is_(False))):
        old.revoked = True
    token = new_token("agt")
    agent = Agent(company_id=company_id, token_hash=hash_token(token))
    db.add(agent)
    db.flush()
    log_event(db, "admin.agent_token_issued", user_id=owner.id, company_id=company_id, agent_id=agent.id)
    db.commit()
    return {"agent_id": agent.id, "token": token}


@router.post("/agents/{agent_id}/revoke")
def revoke_agent(agent_id: int, owner: User = Depends(require_owner), db: Session = Depends(get_db)):
    agent = db.get(Agent, agent_id)
    if not agent:
        raise HTTPException(404, "Agent not found")
    agent.revoked = True
    log_event(db, "admin.agent_revoked", user_id=owner.id, company_id=agent.company_id, agent_id=agent.id)
    db.commit()
    return {"ok": True}
