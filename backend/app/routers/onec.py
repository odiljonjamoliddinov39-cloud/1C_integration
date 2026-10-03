"""Direct API to a company's 1C base: metadata, any object, 1C queries, approval-gated changes.

    GET  /api/onec/{company_id}/metadata
    GET  /api/onec/{company_id}/objects/{kind}/{name}?refs=&from=&to=&filter=&limit=&offset=
    GET  /api/onec/{company_id}/objects/{kind}/{name}/{ref}
    POST /api/onec/{company_id}/query                      {text, params?, limit?}
    POST /api/onec/{company_id}/changes                    {kind, name, action, ref?, data?, post?}

Reads are live (the agent must be online). A change becomes a correction that an owner or
accountant approves on /api/fixes/approve; only then is it written to 1C.
"""

import json

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import check_company, get_current_user, require_writer
from app.models import User, log_event
from app.routers.common import fix_out
from app.services import fixes, onec
from app.services.agent_gateway import AgentCommandError, AgentOffline, AgentTimeout

router = APIRouter(prefix="/api/onec", tags=["1c"])


def _run(fn):
    try:
        return fn()
    except onec.OneCError as e:
        raise HTTPException(e.status, str(e)) from e
    except AgentOffline as e:
        raise HTTPException(503, "1C is offline: the agent for this company is not connected") from e
    except AgentTimeout as e:
        raise HTTPException(504, "1C did not answer in time") from e
    except AgentCommandError as e:
        raise HTTPException(e.status if 400 <= e.status < 600 else 502, {"error": e.code, "message": e.message, "details": e.details}) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/{company_id}/metadata")
def get_metadata(company_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    company = check_company(db, user, company_id)
    return _run(lambda: onec.metadata(db, company))


@router.get("/{company_id}/objects/{kind}/{name}")
def list_objects(
    company_id: int,
    kind: str,
    name: str,
    refs: str | None = None,
    date_from: str | None = Query(None, alias="from"),
    date_to: str | None = Query(None, alias="to"),
    filter: str | None = Query(None, description='JSON object, e.g. {"ИНН": "123456789"}'),
    limit: int = 100,
    offset: int = 0,
    include_deleted: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = check_company(db, user, company_id)
    try:
        parsed_filter = json.loads(filter) if filter else None
    except json.JSONDecodeError as e:
        raise HTTPException(400, "filter must be JSON") from e
    params = {"refs": refs, "from": date_from, "to": date_to, "filter": parsed_filter, "limit": limit, "offset": offset, "include_deleted": include_deleted}
    return _run(lambda: onec.list_objects(db, company, kind, name, params))


@router.get("/{company_id}/objects/{kind}/{name}/{ref}")
def get_object(company_id: int, kind: str, name: str, ref: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    company = check_company(db, user, company_id)
    return _run(lambda: onec.get_object(db, company, kind, name, ref))


class QueryIn(BaseModel):
    text: str
    params: dict = {}
    limit: int | None = None


@router.post("/{company_id}/query")
def run_query(company_id: int, body: QueryIn, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    """Any 1C query (ЗАПРОС). Owners and accountants only: it can read every part of the base."""
    company = check_company(db, user, company_id)
    result = _run(lambda: onec.run_query(db, company, body.text, body.params, body.limit))
    log_event(db, "onec.query", user_id=user.id, company_id=company_id, text=body.text[:2000])
    db.commit()
    return result


class ChangeIn(BaseModel):
    kind: str
    name: str
    action: str
    ref: str | None = None
    data: dict | None = None
    post: bool | None = None
    explanation: str = ""


@router.post("/{company_id}/changes")
def propose_change(company_id: int, body: ChangeIn, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    """Propose a change; nothing reaches 1C until it is approved on /api/fixes/approve."""
    company = check_company(db, user, company_id)
    fix = _run(
        lambda: onec.propose_change(
            db, company, user.id, kind=body.kind, name=body.name, action=body.action, ref=body.ref,
            data=body.data, post=body.post, explanation=body.explanation,
        )
    )
    db.commit()
    return {**fix_out(fix), "preview": fixes.preview(db, company, fix.proposed_change_json)}
