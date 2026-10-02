"""Audit findings (D) and error correction (C)."""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import check_company, get_current_user, require_writer, resolve_companies
from app.models import AuditFinding, Fix, User, log_event
from app.routers.common import finding_out, fix_out, table_to_xlsx
from app.services import ai, fixes, report
from app.services.audit.engine import RULES, SEVERITY_ORDER, run_audit

router = APIRouter(prefix="/api", tags=["audit"])


def _finding(db: Session, user: User, finding_id: int) -> AuditFinding:
    finding = db.get(AuditFinding, finding_id)
    if not finding:
        raise HTTPException(404, "Finding not found")
    check_company(db, user, finding.company_id)
    return finding


def _fix(db: Session, user: User, fix_id: int) -> Fix:
    fix = db.get(Fix, fix_id)
    if not fix:
        raise HTTPException(404, "Fix not found")
    check_company(db, user, fix.company_id)
    return fix


@router.get("/audit/rules")
def list_rules(user: User = Depends(get_current_user)):
    from app.services.audit import rules  # noqa: F401

    return [
        {"code": r.code, "severity": r.severity, "fix_type": r.fix_type, "title": r.title}
        for r in sorted(RULES.values(), key=lambda r: (SEVERITY_ORDER[r.severity], r.code))
    ]


@router.get("/findings")
def list_findings(
    company_id: int | None = None,
    severity: str | None = None,
    rule: str | None = None,
    status: str = "open",
    format: str = "json",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ids = resolve_companies(db, user, company_id)
    q = select(AuditFinding).where(AuditFinding.company_id.in_(ids))
    if status != "all":
        q = q.where(AuditFinding.status.in_(status.split(",")))
    if severity:
        q = q.where(AuditFinding.severity.in_(severity.split(",")))
    if rule:
        q = q.where(AuditFinding.rule_code.in_(rule.split(",")))
    findings = sorted(db.scalars(q), key=lambda f: (SEVERITY_ORDER[f.severity], f.rule_code, f.object_date or f.first_seen.replace(tzinfo=None)))
    out = [finding_out(f) for f in findings]
    if format == "xlsx":
        return table_to_xlsx("findings", [{k: v for k, v in f.items() if k != "details"} for f in out])
    return out


@router.post("/findings/{finding_id}/ignore")
def ignore_finding(finding_id: int, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    finding = _finding(db, user, finding_id)
    finding.status = "ignored"
    log_event(db, "finding.ignored", user_id=user.id, company_id=finding.company_id, object_ref=finding.object_ref, rule=finding.rule_code)
    db.commit()
    return finding_out(finding)


class ExplainIn(BaseModel):
    anonymize: bool | None = None


@router.post("/findings/{finding_id}/explain")
def explain(finding_id: int, body: ExplainIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    finding = _finding(db, user, finding_id)
    try:
        finding.ai_explanation = ai.explain_finding(db, finding, body.anonymize)
    except ai.AIError as e:
        raise HTTPException(e.status, str(e)) from e
    db.commit()
    return finding_out(finding)


@router.post("/companies/{company_id}/audit")
def run_audit_now(company_id: int, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    company = check_company(db, user, company_id)
    new_ids = run_audit(db, company)
    log_event(db, "audit.run", user_id=user.id, company_id=company_id, new_findings=len(new_ids))
    db.commit()
    if new_ids and ai.ai_enabled():
        from app.jobs import enqueue, explain_findings

        enqueue(explain_findings, new_ids)
    return {"new_findings": len(new_ids)}


@router.get("/companies/{company_id}/audit-report.pdf")
def audit_report(company_id: int, month: str | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    company = check_company(db, user, company_id)
    month = month or f"{date.today():%Y-%m}"
    pdf = report.render_pdf(db, company, month)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="audit-{company_id}-{month}.pdf"'})


# --- fixes -----------------------------------------------------------------------------------


class ProposeIn(BaseModel):
    finding_id: int | None = None
    company_id: int | None = None
    fix_type: str | None = None
    object_ref: str | None = None
    params: dict = {}


@router.post("/fixes")
def propose_fix(body: ProposeIn, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    finding = _finding(db, user, body.finding_id) if body.finding_id else None
    company_id = finding.company_id if finding else body.company_id
    if company_id is None:
        raise HTTPException(400, "finding_id or company_id is required")
    company = check_company(db, user, company_id)
    try:
        fix = fixes.propose(db, company, user.id, finding=finding, fix_type=body.fix_type, object_ref=body.object_ref, params=body.params)
        preview = fixes.preview(db, company, fix.proposed_change_json)
    except fixes.FixError as e:
        raise HTTPException(e.status, str(e)) from e
    db.commit()
    return {**fix_out(fix), "preview": preview}


@router.get("/fixes")
def list_fixes(
    company_id: int | None = None, status: str | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    ids = resolve_companies(db, user, company_id)
    q = select(Fix).where(Fix.company_id.in_(ids))
    if status:
        q = q.where(Fix.status.in_(status.split(",")))
    return [fix_out(f) for f in db.scalars(q.order_by(Fix.id.desc()).limit(500))]


@router.get("/fixes/{fix_id}")
def get_fix(fix_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    fix = _fix(db, user, fix_id)
    company = check_company(db, user, fix.company_id)
    try:
        preview = fixes.preview(db, company, fix.proposed_change_json)
    except fixes.FixError:
        preview = None
    finding = db.get(AuditFinding, fix.finding_id) if fix.finding_id else None
    return {**fix_out(fix), "preview": preview, "finding": finding_out(finding) if finding else None}


class ApproveIn(BaseModel):
    fix_ids: list[int]


@router.post("/fixes/approve")
def approve_fixes(body: ApproveIn, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    """Approve one fix or up to 50 of the same type; each gets its own approval_id and log record."""
    items = [_fix(db, user, fid) for fid in body.fix_ids]
    try:
        fixes.approve(db, items, user.id)
    except fixes.FixError as e:
        raise HTTPException(e.status, str(e)) from e
    db.expire_all()  # the agent's reply may already have been applied by the callback
    return [fix_out(db.get(Fix, f.id)) for f in items]


@router.post("/fixes/{fix_id}/reject")
def reject_fix(fix_id: int, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    fix = _fix(db, user, fix_id)
    if fix.status != "proposed":
        raise HTTPException(409, "Only proposed fixes can be rejected")
    fix.status = "rejected"
    log_event(db, "fix.rejected", user_id=user.id, company_id=fix.company_id, fix_id=fix.id)
    db.commit()
    return fix_out(fix)


@router.post("/fixes/{fix_id}/undo")
def undo_fix(fix_id: int, user: User = Depends(require_writer), db: Session = Depends(get_db)):
    fix = _fix(db, user, fix_id)
    try:
        undo = fixes.build_undo(db, fix, user.id)
        preview = fixes.preview(db, check_company(db, user, fix.company_id), undo.proposed_change_json)
    except fixes.FixError as e:
        raise HTTPException(e.status, str(e)) from e
    db.commit()
    return {**fix_out(undo), "preview": preview}
