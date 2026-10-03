"""MCP endpoint (`POST /mcp`, Streamable HTTP with JSON responses) for Claude.ai and Claude Desktop.

Auth: the user's personal MCP token (Settings -> "MCP token" in the web app) as a Bearer token.
Read tools see every company the user can see. Write tools never change 1C directly: they create a
fix proposal or an invoice draft that a person approves in the web app, and they are hidden from
(and refused for) Viewer tokens.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import allowed_company_ids, check_company, user_from_mcp_token
from app.models import AuditFinding, Company, Document, Role, User, log_event
from app.routers.common import document_out, finding_out
from app.services import ai, analytics, fixes
from app.services import invoices as invoice_service

router = APIRouter(tags=["mcp"])
PROTOCOL_VERSION = "2025-06-18"

COMPANY_ARG = {"type": "integer", "description": "Company id; omit for all companies you can see"}

READ_TOOLS = [
    {
        "name": "list_companies",
        "description": "List the companies (1C bases) you can access, with INN and last sync time.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "dashboard",
        "description": "Cash and bank balances, receivables/payables top 10, debt aging, sales/purchases by month, VAT and open findings.",
        "inputSchema": {
            "type": "object",
            "properties": {"company_id": COMPANY_ARG, "date": {"type": "string", "description": "YYYY-MM-DD, default today"}},
        },
    },
    {
        "name": "trial_balance",
        "description": "ОСВ (trial balance) per account for a period.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "company_id": COMPANY_ARG,
                "from": {"type": "string"},
                "to": {"type": "string"},
                "account": {"type": "string", "description": "Account prefix, e.g. 5010"},
            },
            "required": ["from", "to"],
        },
    },
    {
        "name": "list_findings",
        "description": "Open audit findings (CASH-NEG, DUP-DOC, VAT-RATE, ...), with explanations.",
        "inputSchema": {
            "type": "object",
            "properties": {"company_id": COMPANY_ARG, "severity": {"type": "string", "enum": ["critical", "high", "medium", "low"]}},
        },
    },
    {
        "name": "search_documents",
        "description": "Find documents by type, period and counterparty.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "company_id": COMPANY_ARG,
                "type": {"type": "string", "description": "sale, purchase, invoice_out, invoice_in, cash_in, cash_out, bank_in, bank_out"},
                "from": {"type": "string"},
                "to": {"type": "string"},
                "counterparty_ref": {"type": "string"},
                "limit": {"type": "integer", "default": 50},
            },
        },
    },
    {
        "name": "describe_schema",
        "description": "Tables and columns of the 1C mirror, for query_books.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "query_books",
        "description": "Run one read-only SELECT over the 1C mirror (see describe_schema). 10-second timeout, max 200 rows.",
        "inputSchema": {"type": "object", "properties": {"sql": {"type": "string"}}, "required": ["sql"]},
    },
]

ONEC_COMPANY = {"type": "integer", "description": "Company id (one 1C base); see list_companies"}
ONEC_KIND = {"type": "string", "enum": ["catalog", "document", "information_register", "accumulation_register", "accounting_register", "chart_of_accounts", "chart_of_characteristic_types", "enum"]}

READ_TOOLS += [
    {
        "name": "onec_metadata",
        "description": "Live list of everything in a company's 1C base: catalogs, documents, registers, charts of accounts, enums, with their attributes and tabular sections. Use it to find the exact 1C names before reading or changing objects.",
        "inputSchema": {"type": "object", "properties": {"company_id": ONEC_COMPANY}, "required": ["company_id"]},
    },
    {
        "name": "onec_list_objects",
        "description": "Live list of objects of one catalog/document/register from 1C, with all attributes and tabular sections.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "company_id": ONEC_COMPANY,
                "kind": ONEC_KIND,
                "name": {"type": "string", "description": "1C name, e.g. Контрагенты, РеализацияТоваровУслуг"},
                "from": {"type": "string", "description": "Documents: from date YYYY-MM-DD"},
                "to": {"type": "string", "description": "Documents: to date YYYY-MM-DD"},
                "filter": {"type": "object", "description": "Attribute equality filter, e.g. {\"ИНН\": \"123456789\"}"},
                "limit": {"type": "integer", "default": 50},
                "offset": {"type": "integer", "default": 0},
            },
            "required": ["company_id", "kind", "name"],
        },
    },
    {
        "name": "onec_get_object",
        "description": "Live read of one 1C object by its UUID, with all attributes and tabular sections.",
        "inputSchema": {
            "type": "object",
            "properties": {"company_id": ONEC_COMPANY, "kind": ONEC_KIND, "name": {"type": "string"}, "ref": {"type": "string"}},
            "required": ["company_id", "kind", "name", "ref"],
        },
    },
]

# Readable by owners and accountants only (a 1C query can read every part of the base).
WRITER_READ_TOOLS = [
    {
        "name": "onec_query",
        "description": "Run a 1C query (ЗАПРОС language, read-only) on a company's live base, e.g. balances from РегистрБухгалтерии.Хозрасчетный.Остатки. Max 10000 rows.",
        "inputSchema": {
            "type": "object",
            "properties": {"company_id": ONEC_COMPANY, "text": {"type": "string"}, "params": {"type": "object"}, "limit": {"type": "integer"}},
            "required": ["company_id", "text"],
        },
    },
]

WRITE_TOOLS = [
    {
        "name": "propose_fix",
        "description": "Propose the automatic fix for an audit finding. Nothing changes in 1C until a person approves it in the web app.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "finding_id": {"type": "integer"},
                "value": {"type": "string", "description": "New value for 'fill missing field' fixes (INN, IKPU code, contract ref)"},
            },
            "required": ["finding_id"],
        },
    },
    {
        "name": "create_invoice_draft",
        "description": "Save a schet-faktura draft in the web app (not in 1C). A person reviews and sends it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "company_id": {"type": "integer"},
                "buyer_ref": {"type": "string"},
                "contract_ref": {"type": "string"},
                "date": {"type": "string"},
                "rows": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"item_ref": {"type": "string"}, "quantity": {"type": "number"}, "price": {"type": "number"}},
                        "required": ["item_ref", "quantity"],
                    },
                },
            },
            "required": ["company_id", "buyer_ref", "rows"],
        },
    },
]
WRITE_TOOLS.append(
    {
        "name": "onec_propose_change",
        "description": "Propose a change to any catalog item or document in 1C: create, update attributes/tables, post, unpost, mark or unmark deletion. Nothing changes until a person approves it in the web app (Corrections).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "company_id": ONEC_COMPANY,
                "kind": {"type": "string", "enum": ["catalog", "document"]},
                "name": {"type": "string"},
                "action": {"type": "string", "enum": ["create", "update", "post", "unpost", "mark_deletion", "unmark_deletion"]},
                "ref": {"type": "string", "description": "UUID of the object (not for create)"},
                "data": {"type": "object", "description": "{standard: {...}, attributes: {...}, tables: {Name: [rows]}}; references as {\"_type\": \"Справочник.Контрагенты\", \"ref\": \"uuid\"}"},
                "post": {"type": "boolean", "description": "Documents: post after writing"},
                "explanation": {"type": "string"},
            },
            "required": ["company_id", "kind", "name", "action"],
        },
    }
)
WRITE_TOOL_NAMES = {t["name"] for t in WRITE_TOOLS} | {t["name"] for t in WRITER_READ_TOOLS}


class ToolError(Exception):
    pass


def _ids(db: Session, user: User, company_id: int | None) -> list[int]:
    if company_id is None:
        return allowed_company_ids(db, user)
    if company_id not in allowed_company_ids(db, user):
        raise ToolError("No access to this company")
    return [company_id]


def _date(value: str | None, default: date) -> date:
    return date.fromisoformat(value) if value else default


def call_tool(db: Session, user: User, name: str, args: dict) -> Any:
    if name in WRITE_TOOL_NAMES and user.role == Role.VIEWER:
        raise ToolError("Viewer accounts cannot use write tools")
    today = date.today()
    if name == "list_companies":
        ids = allowed_company_ids(db, user)
        return [
            {"id": c.id, "name": c.name, "inn": c.inn, "last_synced_at": c.last_synced_at.isoformat() if c.last_synced_at else None}
            for c in db.scalars(select(Company).where(Company.id.in_(ids)))
        ]
    if name == "dashboard":
        ids = _ids(db, user, args.get("company_id"))
        on = _date(args.get("date"), today)
        data = analytics.dashboard(db, ids, on, date(on.year, 1, 1))
        for key in ("cash", "bank"):
            data["cash_bank"][key].pop("series", None)
        return data
    if name == "trial_balance":
        ids = _ids(db, user, args.get("company_id"))
        return analytics.trial_balance(db, ids, _date(args["from"], today), _date(args["to"], today), args.get("account"))
    if name == "list_findings":
        ids = _ids(db, user, args.get("company_id"))
        q = select(AuditFinding).where(AuditFinding.company_id.in_(ids), AuditFinding.status == "open")
        if args.get("severity"):
            q = q.where(AuditFinding.severity == args["severity"])
        return [finding_out(f) for f in db.scalars(q.limit(200))]
    if name == "search_documents":
        ids = _ids(db, user, args.get("company_id"))
        q = select(Document).where(Document.company_id.in_(ids), Document.deleted.is_(False))
        if args.get("type"):
            q = q.where(Document.type == args["type"])
        if args.get("from"):
            q = q.where(Document.date >= analytics.start_of(_date(args["from"], today)))
        if args.get("to"):
            q = q.where(Document.date < analytics.end_of(_date(args["to"], today)))
        if args.get("counterparty_ref"):
            q = q.where(Document.counterparty_ref == args["counterparty_ref"])
        limit = min(int(args.get("limit") or 50), 500)
        return [document_out(d) for d in db.scalars(q.order_by(Document.date.desc()).limit(limit))]
    if name == "describe_schema":
        return {"tables": ai.QUERYABLE_TABLES, "notes": ai.ACCOUNTS_NOTE}
    if name == "query_books":
        ids = allowed_company_ids(db, user)
        try:
            columns, rows = ai.run_readonly(ai.secure_sql(args["sql"], ids))
        except ai.UnsafeSQL as e:
            raise ToolError(str(e)) from e
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Query failed: {str(e).splitlines()[0][:300]}") from e
        return {"columns": columns, "rows": [[ai.jsonable(v) for v in r] for r in rows[: ai.MAX_RESULT_ROWS]]}
    if name.startswith("onec_"):
        return _onec_tool(db, user, name, args)
    if name == "propose_fix":
        finding = db.get(AuditFinding, int(args["finding_id"]))
        if not finding or finding.company_id not in allowed_company_ids(db, user):
            raise ToolError("Finding not found")
        company = db.get(Company, finding.company_id)
        params = {"value": args["value"]} if args.get("value") else {}
        try:
            fix = fixes.propose(db, company, user.id, finding=finding, params=params)
            preview = fixes.preview(db, company, fix.proposed_change_json)
        except fixes.FixError as e:
            raise ToolError(str(e)) from e
        db.commit()
        return {"fix_id": fix.id, "status": fix.status, "preview": preview, "next_step": "Approve it in the web app"}
    if name == "create_invoice_draft":
        try:
            company = check_company(db, user, int(args["company_id"]))
        except Exception as e:  # noqa: BLE001
            raise ToolError("No access to this company") from e
        data = {k: args.get(k) for k in ("buyer_ref", "contract_ref", "date", "rows") if args.get(k) is not None}
        invoice = invoice_service.save_draft(db, company, user.id, data)
        db.commit()
        return {
            "invoice_id": invoice.id,
            "total": str(invoice.total),
            "vat": str(invoice.vat),
            "errors": invoice_service.validate(db, invoice),
            "next_step": "Review and send it to 1C in the web app",
        }
    raise ToolError(f"Unknown tool {name}")


def _onec_tool(db: Session, user: User, name: str, args: dict) -> Any:
    from app.services import onec
    from app.services.agent_gateway import AgentCommandError, AgentOffline, AgentTimeout

    if int(args.get("company_id") or 0) not in allowed_company_ids(db, user):
        raise ToolError("No access to this company")
    company = db.get(Company, int(args["company_id"]))
    try:
        if name == "onec_metadata":
            return onec.metadata(db, company)
        if name == "onec_list_objects":
            return onec.list_objects(db, company, args.get("kind", ""), args.get("name", ""), {**args, "limit": args.get("limit") or 50})
        if name == "onec_get_object":
            return onec.get_object(db, company, args.get("kind", ""), args.get("name", ""), args.get("ref", ""))
        if name == "onec_query":
            result = onec.run_query(db, company, args.get("text", ""), args.get("params"), args.get("limit"))
            log_event(db, "onec.query", user_id=user.id, company_id=company.id, text=args.get("text", "")[:2000])
            return result
        if name == "onec_propose_change":
            fix = onec.propose_change(
                db, company, user.id, kind=args.get("kind", ""), name=args.get("name", ""), action=args.get("action", ""),
                ref=args.get("ref"), data=args.get("data"), post=args.get("post"), explanation=args.get("explanation", ""),
            )
            db.commit()
            return {"fix_id": fix.id, "status": fix.status, "next_step": "Approve it in the web app (Corrections)"}
    except onec.OneCError as e:
        raise ToolError(str(e)) from e
    except AgentOffline as e:
        raise ToolError("1C is offline: the agent for this company is not connected") from e
    except AgentTimeout as e:
        raise ToolError("1C did not answer in time") from e
    except AgentCommandError as e:
        raise ToolError(f"1C refused: {e.message}") from e
    except ValueError as e:
        raise ToolError(str(e)) from e
    raise ToolError(f"Unknown tool {name}")


def _rpc_result(msg_id, result) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _rpc_error(msg_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def handle_message(db: Session, user: User, msg: dict) -> dict | None:
    method = msg.get("method")
    msg_id = msg.get("id")
    if msg_id is None:  # notification
        return None
    if method == "initialize":
        return _rpc_result(
            msg_id,
            {
                "protocolVersion": msg.get("params", {}).get("protocolVersion", PROTOCOL_VERSION),
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "1c-integration", "version": "1.0.0"},
                "instructions": "Accounting data of the user's 1C companies (Uzbekistan, UZS). Writes only create proposals for human approval.",
            },
        )
    if method == "ping":
        return _rpc_result(msg_id, {})
    if method == "tools/list":
        tools = READ_TOOLS + ([] if user.role == Role.VIEWER else WRITER_READ_TOOLS + WRITE_TOOLS)
        return _rpc_result(msg_id, {"tools": tools})
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name", "")
        try:
            data = call_tool(db, user, name, params.get("arguments") or {})
            log_event(db, "mcp.tool", user_id=user.id, tool=name)
            db.commit()
            text = json.dumps(data, ensure_ascii=False, default=ai.jsonable)
            return _rpc_result(msg_id, {"content": [{"type": "text", "text": text}], "isError": False})
        except ToolError as e:
            db.rollback()
            return _rpc_result(msg_id, {"content": [{"type": "text", "text": str(e)}], "isError": True})
    return _rpc_error(msg_id, -32601, f"Method not found: {method}")


@router.post("/mcp")
async def mcp_post(request: Request, db: Session = Depends(get_db)):
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else None
    user = user_from_mcp_token(db, token)
    if user is None:
        return JSONResponse({"error": "invalid_token"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return JSONResponse(_rpc_error(None, -32700, "Parse error"), status_code=400)
    if isinstance(body, list):
        replies = [r for r in (handle_message(db, user, m) for m in body) if r]
        return JSONResponse(replies) if replies else Response(status_code=202)
    reply = handle_message(db, user, body)
    return JSONResponse(reply) if reply else Response(status_code=202)


@router.get("/mcp")
def mcp_get():
    # No server-initiated stream: clients fall back to plain request/response.
    return Response(status_code=405, headers={"Allow": "POST"})
