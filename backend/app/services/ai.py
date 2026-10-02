"""Claude in the backend: audit explanations and the Ask AI box.

Data sent to Claude is limited to the finding's details and aggregated query results. With
anonymization on, counterparty names and INNs are replaced by tokens before sending and put back
in the answer.

Ask AI: question -> Claude writes one SELECT over the mirror -> the SQL is parsed and checked
(only mirror tables, no schema-qualified names, no dangerous functions) and every table is
replaced by a subquery filtered to the user's companies -> it runs on the read-only database user
in a READ ONLY transaction with a 10-second timeout -> Claude explains the result.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from decimal import Decimal
from functools import lru_cache
from typing import Any

import anthropic
import sqlglot
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from sqlglot import exp

from app.config import get_settings
from app.models import AuditFinding, Company, Counterparty

FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_RESULT_ROWS = 200

# Tables Ask AI may read, with the description Claude sees.
QUERYABLE_TABLES = {
    "companies": "id, name, inn, last_synced_at, closed_period_until",
    "counterparties": "company_id, ref_1c (uuid text), name, inn, contract_refs (jsonb array of {ref,name,number,date}), deleted",
    "items": "company_id, ref_1c, name, unit, price, vat_rate, ikpu_code, deleted",
    "documents": (
        "company_id, ref_1c, type (sale | purchase | invoice_out | invoice_in | cash_in | cash_out | bank_in | bank_out), "
        "number, date (timestamp), posted (bool), deleted (bool), counterparty_ref, contract_ref, amount (total incl. VAT, UZS), "
        "vat, raw_json (jsonb; raw_json->'rows' = [{item_ref, quantity, price, amount, vat_rate, vat_amount, warehouse_ref}])"
    ),
    "ledger_entries": (
        "company_id, document_ref (= documents.ref_1c, or 'OPENING' for opening balances), date (timestamp), "
        "dt_account, kt_account (text codes, e.g. '5010'), amount, subconto_json (jsonb {dt:{counterparty_ref,contract_ref,"
        "item_ref,warehouse_ref,quantity}, kt:{...}})"
    ),
    "invoices": "company_id, ref_1c, number, date, buyer_inn, buyer_name, total, vat, status",
    "audit_findings": "company_id, rule_code, severity, object_ref, message, amount, status (open|fixed|ignored)",
}
COMPANY_COLUMN = {t: ("id" if t == "companies" else "company_id") for t in QUERYABLE_TABLES}

ALLOWED_ANONYMOUS_FUNCS = {
    "to_char", "date_part", "make_date", "jsonb_array_length", "jsonb_array_elements",
    "jsonb_extract_path_text", "jsonb_build_object", "string_agg", "array_agg", "generate_series",
    "greatest", "least", "nullif", "date_trunc", "extract", "abs", "round", "lower", "upper",
}
DENIED_FUNC_PATTERN = re.compile(r"^(pg_|set_config|current_setting|dblink|lo_|query_to|xml|copy|txid|nextval|setval)", re.I)

ACCOUNTS_NOTE = (
    "Chart of accounts (НСБУ Узбекистана): 5010 Касса, 5110 Расчётный счёт, 40xx receivables from buyers, "
    "60xx payables to suppliers, 6410 VAT payable (output VAT credited on sales), 4410 input VAT, 10xx materials, "
    "29xx goods, 9010 revenue, 9110 cost of sales. Balance of an account = sum(amount where dt_account like 'XXXX%') "
    "- sum(amount where kt_account like 'XXXX%'). Entries with document_ref = 'OPENING' carry opening balances. "
    "Amounts are in UZS."
)


class AIError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# --- Claude client ----------------------------------------------------------------------------


@lru_cache
def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=get_settings().anthropic_api_key or None)


def ai_enabled() -> bool:
    return bool(get_settings().anthropic_api_key)


def _call_claude(system: str, user: str, *, schema: dict | None = None, effort: str = "medium") -> str:
    """One Claude request. Server-side fallback keeps a safety false positive from becoming an outage."""
    output_config: dict[str, Any] = {"effort": effort}
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    try:
        response = _client().beta.messages.create(
            model=get_settings().claude_model,
            max_tokens=16000,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            output_config=output_config,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
    except anthropic.RateLimitError as e:
        raise AIError("Claude is rate limited, try again in a minute", 503) from e
    except anthropic.APIConnectionError as e:
        raise AIError("Cannot reach the Claude API", 503) from e
    except anthropic.APIStatusError as e:
        raise AIError(f"Claude API error {e.status_code}", 502) from e
    if response.stop_reason == "refusal":
        raise AIError("Claude declined to answer this request", 422)
    return "".join(b.text for b in response.content if b.type == "text").strip()


# --- anonymization ----------------------------------------------------------------------------


class Anonymizer:
    """Replaces counterparty names and INNs with stable tokens and restores them afterwards."""

    def __init__(self, counterparties: list[Counterparty], enabled: bool):
        self.enabled = enabled
        self.forward: dict[str, str] = {}
        if enabled:
            for i, cp in enumerate(counterparties, start=1):
                if cp.name and len(cp.name) > 2:
                    self.forward.setdefault(cp.name, f"[CP_{i}]")
                if cp.inn:
                    self.forward.setdefault(cp.inn, f"[INN_{i}]")
        self.backward = {v: k for k, v in self.forward.items()}
        self._keys = sorted(self.forward, key=len, reverse=True)

    def mask(self, value: str) -> str:
        if not self.enabled:
            return value
        for key in self._keys:
            value = value.replace(key, self.forward[key])
        return value

    def unmask(self, value: str) -> str:
        if not self.enabled:
            return value
        for token, original in self.backward.items():
            value = value.replace(token, original)
        return value


def _anonymizer(db: Session, company_ids: list[int], enabled: bool) -> Anonymizer:
    cps = list(db.scalars(select(Counterparty).where(Counterparty.company_id.in_(company_ids)))) if enabled else []
    return Anonymizer(cps, enabled)


def jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str, list, dict)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, default=jsonable)


# --- finding explanations ---------------------------------------------------------------------

EXPLAIN_SYSTEM = (
    "You are an experienced chief accountant in Uzbekistan who knows 1C:Бухгалтерия для Узбекистана 3.0. "
    "Explain an automatic audit finding to the company's accountant in plain Russian: what is wrong, the most "
    "likely cause in day-to-day 1C work, and what to check or do next. 3-6 short sentences, no headings. "
    "If the details mention a closed period, say the correction must be made in the current period."
)


def fallback_explanation(finding: AuditFinding) -> str:
    return finding.message


def explain_finding(db: Session, finding: AuditFinding, anonymize: bool | None = None) -> str:
    if not ai_enabled():
        return fallback_explanation(finding)
    anonymize = get_settings().ai_anonymize_default if anonymize is None else anonymize
    anon = _anonymizer(db, [finding.company_id], anonymize)
    payload = {
        "rule": finding.rule_code,
        "severity": finding.severity,
        "message": finding.message,
        "amount": finding.amount,
        "date": finding.object_date,
        "details": finding.details,
        "automatic_fix_available": finding.fix_type,
    }
    answer = _call_claude(EXPLAIN_SYSTEM, anon.mask(_json(payload)), effort="low")
    return anon.unmask(answer)


def explain_findings(db: Session, finding_ids: list[int], anonymize: bool | None = None) -> int:
    done = 0
    for fid in finding_ids:
        finding = db.get(AuditFinding, fid)
        if finding is None or finding.ai_explanation:
            continue
        try:
            finding.ai_explanation = explain_finding(db, finding, anonymize)
            done += 1
        except AIError:
            continue
        db.commit()
    return done


# --- Ask AI -----------------------------------------------------------------------------------


class UnsafeSQL(AIError):
    pass


def _schema_prompt() -> str:
    lines = [f"- {t}({cols})" for t, cols in QUERYABLE_TABLES.items()]
    return "PostgreSQL tables (mirror of 1C data):\n" + "\n".join(lines) + "\n\n" + ACCOUNTS_NOTE


def secure_sql(sql: str, company_ids: list[int]) -> str:
    """Validate a generated query and scope every table to the user's companies."""
    try:
        statements = sqlglot.parse(sql, read="postgres")
    except sqlglot.errors.ParseError as e:
        raise UnsafeSQL(f"Could not parse the generated SQL: {e}") from e
    statements = [s for s in statements if s is not None]
    if len(statements) != 1:
        raise UnsafeSQL("Exactly one statement is allowed")
    tree = statements[0]
    if not isinstance(tree, (exp.Select, exp.Union, exp.Except, exp.Intersect)):
        raise UnsafeSQL("Only SELECT queries are allowed")
    if tree.find(exp.Into) or tree.find(exp.Command):
        raise UnsafeSQL("SELECT INTO and commands are not allowed")
    for node in tree.find_all(exp.Insert, exp.Update, exp.Delete, exp.Create, exp.Drop, exp.Alter):
        raise UnsafeSQL(f"{type(node).__name__} is not allowed")

    for func in tree.find_all(exp.Func):
        name = (func.name if isinstance(func, exp.Anonymous) else func.sql_name()).lower()
        if DENIED_FUNC_PATTERN.match(name):
            raise UnsafeSQL(f"Function {name} is not allowed")
        if isinstance(func, exp.Anonymous) and name not in ALLOWED_ANONYMOUS_FUNCS:
            raise UnsafeSQL(f"Function {name} is not allowed")

    cte_names = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE)}
    for table in tree.find_all(exp.Table):
        if table.args.get("db") or table.args.get("catalog"):
            raise UnsafeSQL("Schema-qualified table names are not allowed")
        name = table.name.lower()
        if name in cte_names:
            continue
        if name not in QUERYABLE_TABLES:
            raise UnsafeSQL(f"Table {table.name} is not available")

    ids = ", ".join(str(int(i)) for i in company_ids) or "NULL"

    def scope(node):
        if isinstance(node, exp.Table) and node.name.lower() in QUERYABLE_TABLES and node.name.lower() not in cte_names:
            name = node.name.lower()
            inner = sqlglot.parse_one(
                f"SELECT * FROM public.{name} WHERE {COMPANY_COLUMN[name]} IN ({ids})", read="postgres"
            )
            return inner.subquery(node.alias_or_name)
        return node

    return tree.transform(scope).sql(dialect="postgres")


@lru_cache
def _readonly_engine():
    return create_engine(get_settings().readonly_database_url, pool_pre_ping=True)


def run_readonly(sql: str, timeout_seconds: int | None = None, engine=None) -> tuple[list[str], list[list]]:
    timeout_ms = int((timeout_seconds or get_settings().ask_ai_timeout_seconds) * 1000)
    engine = engine or _readonly_engine()
    with engine.connect() as conn:
        with conn.begin():
            conn.execute(text("SET TRANSACTION READ ONLY"))
            conn.execute(text(f"SET LOCAL statement_timeout = {timeout_ms}"))
            result = conn.execute(text(sql))
            columns = list(result.keys())
            rows = [list(r) for r in result.fetchmany(MAX_RESULT_ROWS + 1)]
    return columns, rows


SQL_SYSTEM = (
    "You translate accounting questions about 1C data into one PostgreSQL SELECT query over the tables below. "
    "The question may be in Uzbek, Russian or English. Rules: one SELECT (CTEs allowed), no schema prefixes, "
    "aggregate where possible, at most 200 rows, include document numbers/dates/refs when the user asks 'why', "
    "exclude deleted documents and use posted ones unless asked otherwise. The tables are already filtered to the "
    "user's companies; join companies to show company names when several companies are involved.\n\n"
)
SQL_SCHEMA = {
    "type": "object",
    "properties": {
        "sql": {"type": "string", "description": "One PostgreSQL SELECT statement"},
        "approach": {"type": "string", "description": "One sentence on what the query computes"},
    },
    "required": ["sql", "approach"],
    "additionalProperties": False,
}
ANSWER_SYSTEM = (
    "You are a chief accountant answering a question about the company's books from a query result. Answer in the "
    "language of the question (Uzbek, Russian or English). Be specific: cite the dates, document numbers and amounts "
    "behind the answer. If the result is empty or does not answer the question, say so plainly. Amounts are UZS."
)


@dataclass
class AskResult:
    answer: str
    sql: str
    columns: list[str]
    rows: list[list]
    truncated: bool


def ask(db: Session, question: str, company_ids: list[int], anonymize: bool | None = None, engine=None) -> AskResult:
    if not ai_enabled():
        raise AIError("Ask AI needs ANTHROPIC_API_KEY on the server", 503)
    if not question.strip():
        raise AIError("Ask a question")
    anonymize = get_settings().ai_anonymize_default if anonymize is None else anonymize
    anon = _anonymizer(db, company_ids, anonymize)
    companies = [{"id": c.id, "name": c.name} for c in db.scalars(select(Company).where(Company.id.in_(company_ids)))]

    generated = json.loads(
        _call_claude(
            SQL_SYSTEM + _schema_prompt(),
            anon.mask(f"Companies in scope: {_json(companies)}\nQuestion: {question}"),
            schema=SQL_SCHEMA,
        )
    )
    sql = anon.unmask(generated["sql"])
    scoped = secure_sql(sql, company_ids)
    try:
        columns, rows = run_readonly(scoped, engine=engine)
    except Exception as e:  # noqa: BLE001 - surface DB errors (timeout, bad column) to the user
        raise AIError(f"The query failed: {str(e).splitlines()[0][:300]}", 422) from e
    truncated = len(rows) > MAX_RESULT_ROWS
    rows = rows[:MAX_RESULT_ROWS]

    answer = _call_claude(
        ANSWER_SYSTEM,
        anon.mask(
            f"Question: {question}\nQuery approach: {generated.get('approach', '')}\n"
            f"Columns: {_json(columns)}\nRows{' (first 200)' if truncated else ''}: {_json(rows)}"
        ),
    )
    return AskResult(anon.unmask(answer), sql, columns, rows, truncated)
