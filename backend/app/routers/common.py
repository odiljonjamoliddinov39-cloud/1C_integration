from datetime import date, datetime
from decimal import Decimal
from urllib.parse import quote

from fastapi import Response

from app.models import AuditFinding, Company, Document, Fix, Invoice, User
from app.services.excel import to_xlsx

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def xlsx_response(filename: str, columns: list[str], rows: list[list]) -> Response:
    return Response(
        to_xlsx(filename, columns, rows),
        media_type=XLSX,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}.xlsx"},
    )


def table_to_xlsx(filename: str, records: list[dict]) -> Response:
    columns = list(records[0].keys()) if records else []
    return xlsx_response(filename, columns, [[r.get(c) for c in columns] for r in records])


def iso(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def num(value):
    return None if value is None else str(Decimal(value))


def user_out(u: User, company_ids: list[int] | None = None) -> dict:
    return {
        "id": u.id,
        "email": u.email,
        "name": u.name,
        "role": u.role,
        "is_active": u.is_active,
        "totp_enabled": u.totp_enabled,
        "company_ids": company_ids,
    }


def company_out(c: Company, online: bool | None = None, pending: int | None = None) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "inn": c.inn,
        "base_path": c.base_path,
        "last_synced_at": iso(c.last_synced_at),
        "closed_period_until": iso(c.closed_period_until),
        "agent_online": online,
        "pending_commands": pending,
        "base_error": c.base_error,
        "connection_type": c.connection_type,
    }


def document_out(d: Document) -> dict:
    return {
        "id": d.id,
        "company_id": d.company_id,
        "ref_1c": d.ref_1c,
        "type": d.type,
        "number": d.number,
        "date": iso(d.date),
        "posted": d.posted,
        "deleted": d.deleted,
        "counterparty_ref": d.counterparty_ref,
        "contract_ref": d.contract_ref,
        "amount": num(d.amount),
        "vat": num(d.vat),
    }


def finding_out(f: AuditFinding) -> dict:
    return {
        "id": f.id,
        "company_id": f.company_id,
        "rule_code": f.rule_code,
        "severity": f.severity,
        "object_ref": f.object_ref,
        "object_type": f.object_type,
        "object_date": iso(f.object_date),
        "amount": num(f.amount),
        "message": f.message,
        "details": f.details,
        "fix_type": f.fix_type,
        "ai_explanation": f.ai_explanation,
        "status": f.status,
        "first_seen": iso(f.first_seen),
        "last_seen": iso(f.last_seen),
    }


def fix_out(f: Fix) -> dict:
    return {
        "id": f.id,
        "company_id": f.company_id,
        "finding_id": f.finding_id,
        "fix_type": f.fix_type,
        "proposed_change": f.proposed_change_json,
        "explanation": f.explanation,
        "status": f.status,
        "approval_id": f.approval_id,
        "approved_by": f.approved_by,
        "approved_at": iso(f.approved_at),
        "applied_at": iso(f.applied_at),
        "result": f.result,
        "before": f.before_json,
        "after": f.after_json,
        "reverses_fix_id": f.reverses_fix_id,
        "created_at": iso(f.created_at),
    }


def invoice_out(i: Invoice, errors: list | None = None) -> dict:
    return {
        "id": i.id,
        "company_id": i.company_id,
        "ref_1c": i.ref_1c,
        "number": i.number,
        "date": iso(i.date),
        "buyer_ref": i.buyer_ref,
        "buyer_inn": i.buyer_inn,
        "buyer_name": i.buyer_name,
        "contract_ref": i.contract_ref,
        "rows": i.rows,
        "total": num(i.total),
        "vat": num(i.vat),
        "status": i.status,
        "operator_id": i.operator_id,
        "operator_message": i.operator_message,
        "updated_at": iso(i.updated_at),
        "errors": errors,
    }
