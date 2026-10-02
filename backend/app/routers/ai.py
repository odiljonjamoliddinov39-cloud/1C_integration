from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, resolve_companies
from app.models import User, log_event
from app.services import ai

router = APIRouter(prefix="/api/ai", tags=["ai"])


class AskIn(BaseModel):
    question: str
    company_id: int | None = None
    anonymize: bool | None = None


@router.post("/ask")
def ask(body: AskIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ids = resolve_companies(db, user, body.company_id)
    try:
        result = ai.ask(db, body.question, ids, body.anonymize)
    except ai.AIError as e:
        raise HTTPException(e.status, str(e)) from e
    log_event(db, "ai.ask", user_id=user.id, company_id=body.company_id, question=body.question[:500])
    db.commit()
    return {
        "answer": result.answer,
        "sql": result.sql,
        "columns": result.columns,
        "rows": [[ai.jsonable(v) for v in r] for r in result.rows],
        "truncated": result.truncated,
    }
