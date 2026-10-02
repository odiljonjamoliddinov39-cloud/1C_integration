"""Request dependencies: the current user, role checks and the company access filter.

Every query is filtered by the user's company list here, on the backend, never only in the web app.
"""

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Company, Role, User, UserCompany
from app.security import decode_session_token, hash_token


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = _bearer(request)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    user_id = decode_session_token(token)
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired or invalid")
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User disabled")
    return user


def user_from_mcp_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    user = db.scalar(select(User).where(User.mcp_token_hash == hash_token(token)))
    return user if user and user.is_active else None


def allowed_company_ids(db: Session, user: User) -> list[int]:
    if user.role == Role.OWNER:
        return list(db.scalars(select(Company.id).order_by(Company.id)))
    return list(
        db.scalars(
            select(UserCompany.company_id)
            .where(UserCompany.user_id == user.id)
            .order_by(UserCompany.company_id)
        )
    )


def check_company(db: Session, user: User, company_id: int) -> Company:
    if company_id not in allowed_company_ids(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this company")
    company = db.get(Company, company_id)
    if not company:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")
    return company


def resolve_companies(db: Session, user: User, company_id: int | None) -> list[int]:
    """`company_id=None` means the combined view of every company the user can see."""
    if company_id is None:
        return allowed_company_ids(db, user)
    check_company(db, user, company_id)
    return [company_id]


def require_roles(*roles: str):
    def checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role cannot do this")
        return user

    return checker


require_owner = require_roles(Role.OWNER)
require_writer = require_roles(Role.OWNER, Role.ACCOUNTANT)
