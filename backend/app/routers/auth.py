from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import allowed_company_ids, get_current_user, require_owner
from app.models import User, log_event
from app.routers.common import user_out
from app.security import (
    create_session_token,
    hash_token,
    new_token,
    new_totp_secret,
    totp_uri,
    verify_password,
    verify_totp,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str
    totp: str | None = None


@router.post("/login")
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if not user or not user.is_active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong email or password")
    if user.totp_enabled:
        if not body.totp:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "totp_required")
        if not verify_totp(user.totp_secret, body.totp):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong 2FA code")
    log_event(db, "auth.login", user_id=user.id)
    db.commit()
    return {"token": create_session_token(user.id), "user": user_out(user, allowed_company_ids(db, user))}


@router.get("/me")
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return user_out(user, allowed_company_ids(db, user))


@router.post("/totp/setup")
def totp_setup(user: User = Depends(require_owner), db: Session = Depends(get_db)):
    user.totp_secret = new_totp_secret()
    user.totp_enabled = False
    db.commit()
    return {"secret": user.totp_secret, "uri": totp_uri(user.totp_secret, user.email)}


class CodeIn(BaseModel):
    code: str


@router.post("/totp/enable")
def totp_enable(body: CodeIn, user: User = Depends(require_owner), db: Session = Depends(get_db)):
    if not user.totp_secret or not verify_totp(user.totp_secret, body.code):
        raise HTTPException(400, "Wrong code")
    user.totp_enabled = True
    log_event(db, "auth.totp_enabled", user_id=user.id)
    db.commit()
    return {"ok": True}


@router.post("/mcp-token")
def issue_mcp_token(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Personal token for the MCP connector (Claude.ai / Claude Desktop). Shown once."""
    token = new_token("mcp")
    user.mcp_token_hash = hash_token(token)
    log_event(db, "auth.mcp_token_issued", user_id=user.id)
    db.commit()
    return {"token": token}
