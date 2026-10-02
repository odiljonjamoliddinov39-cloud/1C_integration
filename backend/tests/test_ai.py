import json
import os

import pytest
from sqlalchemy import create_engine

from app.models import Counterparty
from app.services import ai
from tests.fake_1c import clean_base


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM documents",
        "SELECT * FROM users",
        "SELECT * FROM agents",
        "SELECT * FROM public.documents",
        "SELECT set_config('x', 'y', true)",
        "SELECT pg_sleep(30)",
        "SELECT 1; SELECT 2",
        "SELECT * INTO evil FROM documents",
        "WITH x AS (DELETE FROM documents RETURNING *) SELECT * FROM x",
    ],
)
def test_unsafe_sql_is_rejected(sql):
    with pytest.raises(ai.UnsafeSQL):
        ai.secure_sql(sql, [1])


def test_queries_are_scoped_to_the_users_companies(harness, db):
    other = harness.add_company("TEXMASH", clean_base())
    harness.full_sync()
    harness.full_sync(other)
    scoped = ai.secure_sql(
        "WITH s AS (SELECT company_id, sum(amount) AS total FROM documents d WHERE d.type = 'sale' GROUP BY company_id) "
        "SELECT c.name, s.total FROM s JOIN companies c ON c.id = s.company_id",
        [harness.company.id],
    )
    ro = create_engine(os.environ["READONLY_DATABASE_URL"])
    columns, rows = ai.run_readonly(scoped, engine=ro)
    assert columns == ["name", "total"]
    assert [r[0] for r in rows] == ["TEST_CRYSTAL"]


def test_readonly_run_has_a_timeout(engine):
    ro = create_engine(os.environ["READONLY_DATABASE_URL"])
    with pytest.raises(Exception, match="statement timeout"):
        ai.run_readonly("SELECT count(*) FROM generate_series(1, 500000000)", timeout_seconds=1, engine=ro)


def test_anonymizer_round_trip():
    cps = [Counterparty(name="ООО Покупатель", inn="123456789"), Counterparty(name="ООО Поставщик", inn="987654321")]
    anon = ai.Anonymizer(cps, enabled=True)
    masked = anon.mask("ООО Покупатель (ИНН 123456789) должен ООО Поставщик")
    assert "Покупатель" not in masked and "123456789" not in masked
    assert anon.unmask(masked) == "ООО Покупатель (ИНН 123456789) должен ООО Поставщик"


def test_ask_flow_with_mocked_claude(harness, db, monkeypatch):
    harness.full_sync()
    calls = []

    def fake_claude(system, user, schema=None, effort="medium"):
        calls.append((system, user, schema))
        if schema:
            return json.dumps(
                {
                    "sql": "SELECT d.number, d.date, d.amount FROM documents d WHERE d.type = 'cash_out' ORDER BY d.date",
                    "approach": "cash payments",
                }
            )
        return "Касса уменьшилась из-за РКО №000005 от 10.09.2026 на 280 000 сум."

    monkeypatch.setattr(ai, "_call_claude", fake_claude)
    monkeypatch.setattr(ai, "ai_enabled", lambda: True)
    ro = create_engine(os.environ["READONLY_DATABASE_URL"])
    result = ai.ask(db, "Почему касса уменьшилась?", [harness.company.id], anonymize=True, engine=ro)
    assert result.columns == ["number", "date", "amount"]
    assert len(result.rows) == 1
    assert "280 000" in result.answer
    # With anonymization on, names never reach Claude.
    assert all("ООО Покупатель" not in user for _, user, _ in calls)


def test_explanation_falls_back_without_api_key(make_harness, db):
    from sqlalchemy import select

    from app.models import AuditFinding

    h = make_harness("NO-INN")
    h.full_sync()
    h.audit()
    finding = db.scalar(select(AuditFinding))
    assert ai.explain_finding(db, finding) == finding.message
