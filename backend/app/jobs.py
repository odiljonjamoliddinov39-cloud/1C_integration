"""Background jobs, run by RQ workers (`rq worker` in deploy/docker-compose.yml).

Set JOBS_EAGER=1 (tests, local demos) to run jobs inline instead of through Redis.
"""

from __future__ import annotations

import logging
import os
from datetime import date
from functools import lru_cache

from app.config import get_settings
from app.db import session_factory
from app.models import Company, log_event
from app.services import ai, fixes, invoices, sync
from app.services.agent_gateway import AgentOffline, AgentTimeout, get_gateway
from app.services.audit.engine import run_audit
from app.services.onec import WrongBase

log = logging.getLogger(__name__)


def _eager() -> bool:
    return os.environ.get("JOBS_EAGER") == "1"


def enqueue(func, *args, **kwargs):
    if _eager():
        return func(*args, **kwargs)
    return _queue().enqueue(func, *args, **kwargs, job_timeout=1800)


@lru_cache
def _queue():
    import redis
    from rq import Queue

    # RQ needs a bytes-mode connection, separate from the decode_responses one used elsewhere.
    return Queue("default", connection=redis.Redis.from_url(get_settings().redis_url))


def sync_company(company_id: int, full: bool = False, audit: bool = True) -> dict:
    db = session_factory()()
    try:
        company = db.get(Company, company_id)
        gateway = get_gateway()

        def fetch(command, params):
            return gateway.call(company_id, command, params)

        try:
            stats = sync.full_sync(db, company, fetch) if full else sync.incremental_sync(db, company, fetch)
        except (AgentOffline, AgentTimeout, WrongBase) as e:
            db.rollback()
            log.info("sync skipped for company %s: %s", company_id, e)
            return {"skipped": str(e)}
        if audit and (full or stats.get("changes")):
            audit_company(company_id)
        return stats
    finally:
        db.close()


def audit_company(company_id: int, explain: bool = True) -> list[int]:
    db = session_factory()()
    try:
        company = db.get(Company, company_id)
        new_ids = run_audit(db, company)
        log_event(db, "audit.run", company_id=company_id, new_findings=len(new_ids))
        db.commit()
    finally:
        db.close()
    if explain and new_ids and ai.ai_enabled():
        enqueue(explain_findings, new_ids)
    return new_ids


def explain_findings(finding_ids: list[int]) -> int:
    db = session_factory()()
    try:
        return ai.explain_findings(db, finding_ids)
    finally:
        db.close()


def command_callback(company_id: int, envelope: dict, reply: dict) -> None:
    """Called with the agent's reply to a queued write command."""
    db = session_factory()()
    try:
        ctx = envelope.get("context") or {}
        callback = envelope.get("callback")
        if callback == "fix_result":
            fixes.handle_result(db, ctx["fix_id"], reply)
        elif callback == "invoice_created":
            invoices.handle_created(db, ctx["invoice_id"], reply)
        elif callback == "invoice_posted":
            invoices.handle_posted(db, ctx["invoice_id"], reply)
        else:
            log.warning("unknown callback %s", callback)
    finally:
        db.close()


def all_company_ids() -> list[int]:
    from sqlalchemy import select

    db = session_factory()()
    try:
        return list(db.scalars(select(Company.id)))
    finally:
        db.close()


def nightly(today: date | None = None) -> None:
    for cid in all_company_ids():
        enqueue(audit_company, cid)
