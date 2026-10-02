"""Error correction (Function C): propose -> approve (approval_id) -> agent applies -> re-check.

The system never changes the books on its own. A fix is only sent to 1C after an owner or
accountant approves it, which issues the `approval_id` the extension demands for every write.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditFinding, Company, Counterparty, Document, Fix, Item, LedgerEntry, log_event
from app.services.agent_gateway import AgentOffline, AgentTimeout, get_gateway
from app.services.audit.engine import FixType, rule_still_fires

MAX_BULK_APPROVE = 50
FIELD_TARGETS = {"inn": "counterparty", "ikpu_code": "item", "vat_rate": "item", "contract_ref": "document"}


class FixError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# --- building proposals -------------------------------------------------------------------------


def _document(db: Session, company_id: int, ref: str) -> Document:
    doc = db.scalar(select(Document).where(Document.company_id == company_id, Document.ref_1c == ref))
    if not doc:
        raise FixError("Document not found in the mirror", 404)
    return doc


def _validate_field_value(field: str, value):
    if value in (None, ""):
        raise FixError(f"A value for {field} is required")
    if field == "inn" and not re.fullmatch(r"\d{9}|\d{14}", str(value)):
        raise FixError("INN must be 9 or 14 digits")
    if field == "ikpu_code" and not re.fullmatch(r"\d{17}", str(value)):
        raise FixError("IKPU code must be 17 digits")
    if field == "vat_rate" and str(value) not in ("0", "12", "15"):
        raise FixError("VAT rate must be 0, 12 or 15")


def build_change(db: Session, company: Company, fix_type: str, object_ref: str, params: dict) -> dict:
    """Return the proposed change sent to the extension's POST /fixes (minus approval_id)."""
    params = params or {}
    if fix_type == FixType.FILL_FIELD:
        field = params.get("field")
        if field not in FIELD_TARGETS:
            raise FixError(f"Field must be one of {', '.join(FIELD_TARGETS)}")
        value = params.get("value")
        _validate_field_value(field, value)
        kind = FIELD_TARGETS[field]
        obj = {"kind": kind, "ref": object_ref}
        if kind == "document":
            obj["type"] = _document(db, company.id, object_ref).type
        return {"type": fix_type, "object": obj, "changes": {"field": field, "value": value}}

    if fix_type == FixType.REPOST:
        doc = _document(db, company.id, object_ref)
        return {"type": fix_type, "object": {"kind": "document", "type": doc.type, "ref": doc.ref_1c}, "changes": {}}

    if fix_type == FixType.CORRECT_VAT:
        doc = _document(db, company.id, object_ref)
        items = {i.ref_1c: i for i in db.scalars(select(Item).where(Item.company_id == company.id))}
        rows = []
        for idx, row in enumerate((doc.raw_json or {}).get("rows", [])):
            item = items.get(row.get("item_ref"))
            if item and item.vat_rate is not None and row.get("vat_rate") is not None:
                if Decimal(str(row["vat_rate"])) != item.vat_rate:
                    rows.append({"row": idx + 1, "item_ref": item.ref_1c, "vat_rate": float(item.vat_rate)})
        if not rows:
            raise FixError("All rows already match their items' VAT rates")
        return {
            "type": fix_type,
            "object": {"kind": "document", "type": doc.type, "ref": doc.ref_1c},
            "changes": {"rows": rows, "repost": True},
        }

    if fix_type == FixType.REVERSE_DUPLICATE:
        doc = _document(db, company.id, object_ref)
        return {
            "type": fix_type,
            "object": {"kind": "document", "type": doc.type, "ref": doc.ref_1c},
            "changes": {"unpost": True, "deletion_mark": True},
        }

    if fix_type == FixType.MERGE_COUNTERPARTIES:
        main_ref = params.get("main_ref")
        if not main_ref or main_ref == object_ref:
            raise FixError("main_ref (the counterparty to keep) is required")
        cps = {
            c.ref_1c: c
            for c in db.scalars(
                select(Counterparty).where(
                    Counterparty.company_id == company.id, Counterparty.ref_1c.in_([main_ref, object_ref])
                )
            )
        }
        if len(cps) != 2:
            raise FixError("Both counterparties must exist in the mirror", 404)
        docs = list(
            db.scalars(
                select(Document).where(
                    Document.company_id == company.id,
                    Document.counterparty_ref == object_ref,
                    Document.deleted.is_(False),
                )
            )
        )
        return {
            "type": fix_type,
            "object": {"kind": "counterparty", "ref": object_ref},
            "changes": {
                "main_ref": main_ref,
                "documents": [{"type": d.type, "ref": d.ref_1c} for d in docs],
                "deletion_mark": True,
            },
        }

    raise FixError(f"Unknown fix type {fix_type}")


def preview(db: Session, company: Company, change: dict) -> dict:
    """Side-by-side data for the UI: current value, new value and affected entries."""
    obj = change["object"]
    current: dict = {}
    proposed: dict = {}
    affected_entries: list[dict] = []
    if obj["kind"] == "document":
        doc = _document(db, company.id, obj["ref"])
        current = {
            "number": doc.number,
            "date": doc.date.isoformat(),
            "posted": doc.posted,
            "amount": str(doc.amount),
            "vat": str(doc.vat),
            "contract_ref": doc.contract_ref,
            "rows": (doc.raw_json or {}).get("rows", []),
        }
        entries = db.scalars(
            select(LedgerEntry).where(LedgerEntry.company_id == company.id, LedgerEntry.document_ref == doc.ref_1c)
        )
        affected_entries = [
            {"date": e.date.isoformat(), "dt": e.dt_account, "kt": e.kt_account, "amount": str(e.amount)}
            for e in entries
        ]
    elif obj["kind"] == "counterparty":
        cp = db.scalar(
            select(Counterparty).where(Counterparty.company_id == company.id, Counterparty.ref_1c == obj["ref"])
        )
        current = {"name": cp.name, "inn": cp.inn} if cp else {}
    elif obj["kind"] == "item":
        item = db.scalar(select(Item).where(Item.company_id == company.id, Item.ref_1c == obj["ref"]))
        current = (
            {"name": item.name, "ikpu_code": item.ikpu_code, "vat_rate": str(item.vat_rate)} if item else {}
        )

    ch = change["changes"]
    t = change["type"]
    if t == FixType.FILL_FIELD:
        current = {**current, "field": ch["field"], "value": current.get(ch["field"])}
        proposed = {"field": ch["field"], "value": ch["value"]}
    elif t == FixType.CORRECT_VAT:
        proposed = {"rows": ch["rows"], "then": "re-post the document"}
    elif t == FixType.REPOST:
        proposed = {"action": "re-post the document so its entries match its rows"}
    elif t == FixType.REVERSE_DUPLICATE:
        proposed = {"posted": False, "deletion_mark": True}
    elif t == FixType.MERGE_COUNTERPARTIES:
        proposed = {"main_ref": ch["main_ref"], "documents_moved": len(ch["documents"]), "deletion_mark": True}
    return {"current": current, "proposed": proposed, "affected_entries": affected_entries}


def object_date(db: Session, company: Company, change: dict) -> datetime | None:
    obj = change["object"]
    if obj["kind"] == "document":
        doc = db.scalar(select(Document).where(Document.company_id == company.id, Document.ref_1c == obj["ref"]))
        return doc.date if doc else None
    return None


def in_closed_period(company: Company, when: datetime | None) -> bool:
    return bool(company.closed_period_until and when and when.date() <= company.closed_period_until)


def propose(
    db: Session,
    company: Company,
    user_id: int,
    *,
    finding: AuditFinding | None = None,
    fix_type: str | None = None,
    object_ref: str | None = None,
    params: dict | None = None,
) -> Fix:
    params = dict(params or {})
    if finding is not None:
        if finding.status != "open":
            raise FixError("Only open findings can be fixed")
        if not finding.fix_type:
            raise FixError("This finding has no automatic fix; it needs investigation")
        fix_type = finding.fix_type
        object_ref = finding.object_ref
        details = finding.details or {}
        if fix_type == FixType.FILL_FIELD:
            params.setdefault("field", details.get("field"))
            if params.get("value") in (None, "") and details.get("suggested"):
                params["value"] = details["suggested"]
        if fix_type == FixType.MERGE_COUNTERPARTIES:
            params.setdefault("main_ref", details.get("main_ref"))
    if not fix_type or not object_ref:
        raise FixError("fix_type and object_ref are required")

    change = build_change(db, company, fix_type, object_ref, params)
    if in_closed_period(company, object_date(db, company, change)):
        raise FixError("The document is in a closed period; correct it in the current period", 409)

    fix = Fix(
        company_id=company.id,
        finding_id=finding.id if finding else None,
        fix_type=fix_type,
        proposed_change_json=change,
        explanation=(finding.ai_explanation or finding.message) if finding else "",
        requested_by=user_id,
        status="proposed",
    )
    db.add(fix)
    db.flush()
    log_event(db, "fix.proposed", user_id=user_id, company_id=company.id, object_ref=object_ref, fix_id=fix.id)
    return fix


# --- approval and application ------------------------------------------------------------------


def approve(db: Session, fixes: list[Fix], user_id: int) -> list[Fix]:
    if not fixes:
        raise FixError("Nothing to approve")
    if len(fixes) > MAX_BULK_APPROVE:
        raise FixError(f"At most {MAX_BULK_APPROVE} fixes per bulk approval")
    if len({f.fix_type for f in fixes}) > 1:
        raise FixError("Bulk approval needs fixes of the same type")
    gateway = get_gateway()
    now = datetime.now(timezone.utc)
    for fix in fixes:
        if fix.status != "proposed":
            raise FixError(f"Fix {fix.id} is {fix.status}, not proposed")
    for fix in fixes:
        company = db.get(Company, fix.company_id)
        if in_closed_period(company, object_date(db, company, fix.proposed_change_json)):
            fix.status = "rejected"
            fix.result = "Closed period: correct in the current period"
            log_event(db, "fix.refused_closed_period", user_id=user_id, company_id=fix.company_id, fix_id=fix.id)
            continue
        fix.approval_id = str(uuid.uuid4())
        fix.approved_by = user_id
        fix.approved_at = now
        fix.status = "approved"
        log_event(
            db,
            "fix.approved",
            user_id=user_id,
            company_id=fix.company_id,
            object_ref=fix.proposed_change_json["object"]["ref"],
            fix_id=fix.id,
            approval_id=fix.approval_id,
        )
    db.commit()
    for fix in fixes:
        if fix.status == "approved":
            payload = {**fix.proposed_change_json, "approval_id": fix.approval_id, "fix_id": fix.id}
            gateway.enqueue(fix.company_id, "apply_fix", payload, callback="fix_result", context={"fix_id": fix.id})
    return fixes


def affected_objects(db: Session, fix: Fix) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    change = fix.proposed_change_json
    obj = change["object"]
    docs: dict[str, list[str]] = {}
    catalogs: dict[str, list[str]] = {}
    if obj["kind"] == "document":
        docs.setdefault(obj["type"], []).append(obj["ref"])
    elif obj["kind"] == "counterparty":
        catalogs["counterparties"] = [obj["ref"]]
    elif obj["kind"] == "item":
        catalogs["items"] = [obj["ref"]]
    if change["type"] == FixType.MERGE_COUNTERPARTIES or change.get("reverse_of") == FixType.MERGE_COUNTERPARTIES:
        main = change["changes"].get("main_ref")
        if main:
            catalogs.setdefault("counterparties", []).append(main)
        for d in change["changes"].get("documents", []):
            docs.setdefault(d["type"], []).append(d["ref"])
    return docs, catalogs


def handle_result(db: Session, fix_id: int, reply: dict) -> Fix:
    """Callback for the agent's reply to apply_fix; runs in a worker."""
    from app.services import sync

    fix = db.get(Fix, fix_id)
    if fix is None:
        raise FixError("Fix not found", 404)
    now = datetime.now(timezone.utc)
    if not reply.get("ok"):
        err = reply.get("error") or {}
        fix.status = "failed"
        fix.result = f"{err.get('error', 'error')}: {err.get('message', '')}"
        log_event(db, "fix.failed", company_id=fix.company_id, fix_id=fix.id, error=err, status=reply.get("status"))
        db.commit()
        return fix

    data = reply.get("data") or {}
    fix.before_json = data.get("before")
    fix.after_json = data.get("after")
    fix.applied_at = now
    fix.status = "applied"
    fix.result = "applied"
    log_event(
        db,
        "fix.applied",
        user_id=fix.approved_by,
        company_id=fix.company_id,
        object_ref=fix.proposed_change_json["object"]["ref"],
        fix_id=fix.id,
        approval_id=fix.approval_id,
    )
    db.commit()

    # Re-sync what changed, re-run the rule, and close the finding only if it no longer fires.
    company = db.get(Company, fix.company_id)
    gateway = get_gateway()
    try:
        def fetch(command, params):
            return gateway.call(company.id, command, params)

        docs, catalogs = affected_objects(db, fix)
        sync.resync_documents(db, company, fetch, docs)
        for name, refs in catalogs.items():
            sync.resync_catalog_refs(db, company, fetch, name, refs)
        db.commit()
    except (AgentOffline, AgentTimeout):
        fix.result = "applied; re-sync pending (agent offline)"
        db.commit()
        return fix

    finding = db.get(AuditFinding, fix.finding_id) if fix.finding_id else None
    if finding is not None:
        fires = rule_still_fires(db, company, finding.rule_code, finding.object_ref)
        if fix.fix_type == "restore":
            if fires:
                finding.status = "open"
                finding.resolved_at = None
        elif fires:
            fix.result = "applied, but the rule still fires"
        else:
            finding.status = "fixed"
            finding.resolved_at = now
    db.commit()
    return fix


def build_undo(db: Session, fix: Fix, user_id: int) -> Fix:
    """A reverse fix restores `before_json`. It is approved and applied like any other fix."""
    if fix.status != "applied" or not fix.before_json:
        raise FixError("Only applied fixes with stored before values can be undone")
    if db.scalar(select(Fix).where(Fix.reverses_fix_id == fix.id, Fix.status.in_(["proposed", "approved", "applied"]))):
        raise FixError("This fix already has an undo")
    original = fix.proposed_change_json
    change = {
        "type": "restore",
        "reverse_of": original["type"],
        "object": original["object"],
        "changes": {**original["changes"], "restore": fix.before_json},
    }
    company = db.get(Company, fix.company_id)
    if in_closed_period(company, object_date(db, company, change)):
        raise FixError("The document is now in a closed period; it cannot be undone", 409)
    undo = Fix(
        company_id=fix.company_id,
        finding_id=fix.finding_id,
        fix_type="restore",
        proposed_change_json=change,
        explanation=f"Undo of fix #{fix.id}",
        requested_by=user_id,
        reverses_fix_id=fix.id,
        status="proposed",
    )
    db.add(undo)
    db.flush()
    log_event(db, "fix.undo_proposed", user_id=user_id, company_id=fix.company_id, fix_id=undo.id, reverses=fix.id)
    return undo
