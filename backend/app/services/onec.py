"""Direct access to a company's 1C base through its agent: any object, any query, any change.

Reads go live to 1C (the agent must be online). Every change is a proposal that a person
approves (a `Fix` with fix_type "object_write"), so it gets an approval_id, runs in one 1C
transaction, is logged on both sides and can be undone.

Every call first checks that the agent is connected to the *right* base: the INN and base name
1C reports must match the company. A token wired to the wrong base can neither sync nor write.
"""

from __future__ import annotations

import re
import time
from datetime import date, datetime
from pathlib import PureWindowsPath
from typing import Any

from sqlalchemy.orm import Session

from app.models import Company, Fix, log_event
from app.services.agent_gateway import get_gateway

# API kind -> 1C metadata class (the extension uses the same names).
KINDS = {
    "catalog": "Справочник",
    "document": "Документ",
    "information_register": "РегистрСведений",
    "accumulation_register": "РегистрНакопления",
    "accounting_register": "РегистрБухгалтерии",
    "chart_of_accounts": "ПланСчетов",
    "chart_of_characteristic_types": "ПланВидовХарактеристик",
    "enum": "Перечисление",
}
WRITABLE_KINDS = {"catalog", "document"}
ACTIONS = {"create", "update", "post", "unpost", "mark_deletion", "unmark_deletion"}
DOCUMENT_ONLY_ACTIONS = {"post", "unpost"}
# 1C identifiers: letters (Latin or Cyrillic), digits, underscore; never a path or a query.
NAME_RE = re.compile(r"^[A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]{0,79}$")
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
MAX_LIST = 5000
MAX_QUERY_ROWS = 10000

# 1C names of the objects the mirror keeps, so a change can be re-synced right after it applies.
MIRRORED_DOCUMENTS = {
    "РеализацияТоваровУслуг": "sale",
    "ПоступлениеТоваровУслуг": "purchase",
    "СчетФактураВыданный": "invoice_out",
    "СчетФактураПолученный": "invoice_in",
    "ПриходныйКассовыйОрдер": "cash_in",
    "РасходныйКассовыйОрдер": "cash_out",
    "ПоступлениеНаРасчетныйСчет": "bank_in",
    "СписаниеСРасчетногоСчета": "bank_out",
    "ОперацияБух": "operation",
}
MIRRORED_CATALOGS = {"Контрагенты": "counterparties", "Номенклатура": "items", "ДоговорыКонтрагентов": "contracts"}

VERIFY_TTL_SECONDS = 600
_verified: dict[int, float] = {}


class OneCError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class WrongBase(OneCError):
    def __init__(self, message: str):
        super().__init__(message, 409)


# --- right-base guard ---------------------------------------------------------------------------


def _expected_base_name(company: Company) -> str | None:
    if not company.base_path:
        return None
    return PureWindowsPath(company.base_path.replace("/", "\\")).name or None


def check_base(db: Session, company: Company, info: dict) -> None:
    """Compare what 1C reports in /ping with the company. Raises WrongBase on a mismatch.

    The first ping fills an empty company INN; after that it must stay the same.
    """
    problems = []
    reported_inn = (info.get("inn") or "").strip()
    if company.inn and reported_inn and reported_inn != company.inn:
        problems.append(f"INN {reported_inn} instead of {company.inn}")
    expected = _expected_base_name(company)
    reported_base = (info.get("base_name") or "").strip()
    if expected and reported_base and reported_base.lower() != expected.lower():
        problems.append(f"base {reported_base} instead of {expected}")
    if problems:
        message = f"The agent for {company.name} is connected to the wrong 1C base: " + ", ".join(problems)
        if company.base_error != message:
            company.base_error = message
            log_event(db, "agent.wrong_base", company_id=company.id, reported_inn=reported_inn, reported_base=reported_base)
        db.commit()
        _verified.pop(company.id, None)
        raise WrongBase(message)
    if reported_inn and not company.inn:
        company.inn = reported_inn
    if company.base_error:
        company.base_error = None
        log_event(db, "agent.base_confirmed", company_id=company.id)
    _verified[company.id] = time.monotonic()


def ensure_right_base(db: Session, company: Company, fetch=None) -> None:
    """Ping 1C (at most every 10 minutes per company) and run check_base.

    `fetch(command, params)` defaults to the agent gateway; sync passes its own.
    """
    seen = _verified.get(company.id)
    if seen is not None and time.monotonic() - seen < VERIFY_TTL_SECONDS and not company.base_error:
        return
    info = fetch("ping", {}) if fetch else get_gateway().call(company.id, "ping", {})
    check_base(db, company, info)
    db.commit()


def forget_verification(company_id: int | None = None) -> None:
    if company_id is None:
        _verified.clear()
    else:
        _verified.pop(company_id, None)


# --- reads ----------------------------------------------------------------------------------------


def _check_name(kind: str, name: str) -> None:
    if kind not in KINDS:
        raise OneCError(f"kind must be one of {', '.join(KINDS)}")
    if not NAME_RE.match(name or ""):
        raise OneCError("Invalid 1C object name")


def _check_ref(ref: str) -> None:
    if not UUID_RE.match(ref or ""):
        raise OneCError("ref must be a 1C UUID")


def _call(db: Session, company: Company, command: str, params: dict) -> Any:
    ensure_right_base(db, company)
    return get_gateway().call(company.id, command, params)


def metadata(db: Session, company: Company) -> dict:
    return _call(db, company, "get_metadata", {})


def list_objects(db: Session, company: Company, kind: str, name: str, params: dict) -> dict:
    _check_name(kind, name)
    clean: dict[str, Any] = {"kind": kind, "name": name}
    if params.get("refs"):
        refs = params["refs"] if isinstance(params["refs"], list) else str(params["refs"]).split(",")
        for r in refs:
            _check_ref(r)
        clean["refs"] = refs
    for key in ("from", "to"):
        if params.get(key):
            clean[key] = date.fromisoformat(str(params[key])).isoformat()
    if params.get("filter"):
        if not isinstance(params["filter"], dict) or not all(NAME_RE.match(k) for k in params["filter"]):
            raise OneCError("filter must be an object of attribute name -> value")
        clean["filter"] = params["filter"]
    clean["limit"] = max(1, min(int(params.get("limit") or 100), MAX_LIST))
    clean["offset"] = max(0, int(params.get("offset") or 0))
    if params.get("include_deleted"):
        clean["include_deleted"] = True
    return _call(db, company, "list_objects", clean)


def get_object(db: Session, company: Company, kind: str, name: str, ref: str) -> dict:
    _check_name(kind, name)
    _check_ref(ref)
    return _call(db, company, "get_object", {"kind": kind, "name": name, "ref": ref})


def run_query(db: Session, company: Company, text: str, params: dict | None = None, limit: int | None = None) -> dict:
    """Run a 1C query (ЗАПРОС). The 1C query language cannot change data, so this is read-only."""
    if not text or not text.strip():
        raise OneCError("Query text is required")
    if len(text) > 20000:
        raise OneCError("Query text is too long")
    if params is not None and (not isinstance(params, dict) or not all(NAME_RE.match(k) for k in params)):
        raise OneCError("params must be an object of parameter name -> value")
    return _call(
        db,
        company,
        "run_query",
        {"text": text, "params": params or {}, "limit": max(1, min(int(limit or 1000), MAX_QUERY_ROWS))},
    )


# --- changes (always through approval) -----------------------------------------------------------


def _document_date(snapshot: dict | None, data: dict | None) -> datetime | None:
    for source in (data or {}, snapshot or {}):
        value = (source.get("standard") or {}).get("Дата")
        if value:
            try:
                return datetime.fromisoformat(str(value)[:19])
            except ValueError:
                continue
    return None


def _validate_data(data: Any) -> dict:
    if data is None:
        return {}
    if not isinstance(data, dict) or set(data) - {"standard", "attributes", "tables"}:
        raise OneCError("data must be {standard?, attributes?, tables?}")
    for part in ("standard", "attributes", "tables"):
        section = data.get(part) or {}
        if not isinstance(section, dict) or not all(NAME_RE.match(k) for k in section):
            raise OneCError(f"data.{part} must be an object keyed by 1C names")
    for rows in (data.get("tables") or {}).values():
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise OneCError("each table in data.tables must be a list of rows")
    return data


def propose_change(
    db: Session,
    company: Company,
    user_id: int,
    *,
    kind: str,
    name: str,
    action: str,
    ref: str | None = None,
    data: dict | None = None,
    post: bool | None = None,
    explanation: str = "",
) -> Fix:
    """Create an approval-gated change of any catalog item or document."""
    if company.base_error:
        raise WrongBase(company.base_error)  # a create does not call 1C, so check the last known state
    _check_name(kind, name)
    if kind not in WRITABLE_KINDS:
        raise OneCError("Only catalogs and documents can be changed")
    if action not in ACTIONS:
        raise OneCError(f"action must be one of {', '.join(sorted(ACTIONS))}")
    if action in DOCUMENT_ONLY_ACTIONS and kind != "document":
        raise OneCError(f"{action} applies to documents only")
    if action == "create":
        ref = None
    else:
        _check_ref(ref or "")
    data = _validate_data(data)
    if action in ("create", "update") and not data:
        raise OneCError("data is required to create or update")

    current = get_object(db, company, kind, name, ref) if ref else None
    when = _document_date(current, data) if kind == "document" else None
    if company.closed_period_until and when and when.date() <= company.closed_period_until:
        raise OneCError("The document is in a closed period; correct it in the current period", 409)

    change = {
        "type": "object_write",
        "object": {"kind": kind, "name": name, "ref": ref},
        "changes": {"action": action, "data": data, "post": post},
        "current": current,
        "object_date": when.isoformat() if when else None,
    }
    fix = Fix(
        company_id=company.id,
        fix_type="object_write",
        proposed_change_json=change,
        explanation=explanation,
        requested_by=user_id,
        status="proposed",
    )
    db.add(fix)
    db.flush()
    log_event(
        db,
        "onec.change_proposed",
        user_id=user_id,
        company_id=company.id,
        object_ref=ref or f"new {kind} {name}",
        fix_id=fix.id,
        change_action=action,
    )
    return fix


def undo_change(original: dict, before: dict, after: dict | None) -> dict:
    """The reverse of an applied object_write: delete-mark a created object, else restore `before`."""
    obj = dict(original["object"])
    if original["changes"]["action"] == "create":
        obj["ref"] = (after or {}).get("ref")
        changes = {"action": "mark_deletion"}
    else:
        changes = {"action": "restore", "snapshot": before}
    return {
        "type": "restore",
        "reverse_of": "object_write",
        "object": obj,
        "changes": changes,
        "current": after,
        "object_date": original.get("object_date"),
    }


def write_payload(change: dict) -> dict:
    """The write_object command for the agent, built from a proposal or an undo."""
    obj = change["object"]
    ch = change["changes"]
    payload = {"kind": obj["kind"], "name": obj["name"], "ref": obj.get("ref"), "action": ch["action"]}
    if ch.get("data") is not None:
        payload["data"] = ch["data"]
    if ch.get("post") is not None:
        payload["post"] = ch["post"]
    if ch.get("snapshot") is not None:
        payload["snapshot"] = ch["snapshot"]
    return payload


def is_object_write(change: dict) -> bool:
    return change.get("type") == "object_write" or change.get("reverse_of") == "object_write"


def mirrored_objects(change: dict, after: dict | None) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Which mirrored documents/catalog items a generic change touched, for an immediate re-sync."""
    obj = change["object"]
    ref = obj.get("ref") or (after or {}).get("ref")
    docs: dict[str, list[str]] = {}
    catalogs: dict[str, list[str]] = {}
    if not ref:
        return docs, catalogs
    if obj["kind"] == "document" and obj["name"] in MIRRORED_DOCUMENTS:
        docs[MIRRORED_DOCUMENTS[obj["name"]]] = [ref]
    if obj["kind"] == "catalog" and obj["name"] in MIRRORED_CATALOGS and obj["name"] != "ДоговорыКонтрагентов":
        catalogs[MIRRORED_CATALOGS[obj["name"]]] = [ref]
    return docs, catalogs
