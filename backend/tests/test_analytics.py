"""Acceptance test B: cash, receivables and OCB match the base's own figures to the sum."""

from datetime import date

from app.models import Role
from app.services import analytics
from tests.conftest import login, make_user
from tests.fake_1c import TODAY


def test_figures_match_the_books(harness, db):
    harness.full_sync()
    ids = [harness.company.id]
    cash = analytics.cash_and_bank(db, ids, TODAY)
    assert cash["cash"]["balance"] == "720000.00"  # 1 000 000 opening - 280 000 paid to supplier
    assert cash["bank"]["balance"] == "224000.00"
    assert cash["cash"]["series"][-1]["balance"] == "720000.00"

    rp = analytics.receivables_payables(db, ids, TODAY)
    assert rp["receivables"]["total"] == "0"
    rp_mid = analytics.receivables_payables(db, ids, date(2026, 9, 6))
    assert rp_mid["receivables"]["top"][0]["balance"] == "224000.00"
    assert rp_mid["receivables"]["top"][0]["name"] == "ООО Покупатель"
    assert rp_mid["payables"]["total"] == "280000.00"

    tb = {r["account"]: r for r in analytics.trial_balance(db, ids, date(2026, 9, 1), date(2026, 9, 30))}
    assert tb["5010"]["opening_dt"] == "1000000.00"
    assert tb["5010"]["turnover_kt"] == "280000.00"
    assert tb["5010"]["closing_dt"] == "720000.00"
    assert tb["4010"]["turnover_dt"] == tb["4010"]["turnover_kt"] == "224000.00"
    assert tb["6410"]["closing_kt"] == "24000.00"
    # The trial balance balances.
    total = lambda k: sum(float(r[k]) for r in tb.values())  # noqa: E731
    assert round(total("turnover_dt"), 2) == round(total("turnover_kt"), 2)

    vat = {r["month"]: r for r in analytics.vat_summary(db, ids, date(2026, 1, 1), TODAY)}
    assert vat["2026-09"] == {"month": "2026-09", "output": "24000.00", "input": "30000.00", "payable": "-6000.00", "invoiced": "24000.00"}

    sales = {r["month"]: r for r in analytics.sales_purchases(db, ids, date(2026, 1, 1), TODAY)}
    assert sales["2026-09"] == {"month": "2026-09", "sales": "224000.00", "purchases": "280000.00"}


def test_debt_aging(make_harness, db):
    h = make_harness("OLD-DEBT")
    h.full_sync()
    data = analytics.debt_aging(db, [h.company.id], TODAY)
    assert data["buckets"]["90+"] == "11200.00"
    assert data["counterparties"][0]["name"] == "ООО Должник"


def test_dashboard_combined_view_and_click_through(client, harness, db):
    from tests.fake_1c import clean_base

    other = harness.add_company("TEXMASH", clean_base())
    harness.full_sync()
    harness.full_sync(other)
    make_user(db, "owner@example.com", Role.OWNER)
    headers = login(client, "owner@example.com")
    dash = client.get(f"/api/analytics/dashboard?date={TODAY}", headers=headers).json()
    assert dash["company_ids"] == [harness.company.id, other.id]
    assert dash["cash_bank"]["cash"]["balance"] == "1440000.00"
    assert dash["last_synced_at"]

    # Click-through: the documents behind the cash figure.
    docs = client.get(f"/api/documents?company_id={harness.company.id}&account=5010", headers=headers).json()
    assert [d["type"] for d in docs] == ["cash_out"]
    detail = client.get(f"/api/documents/{harness.company.id}/{docs[0]['ref_1c']}", headers=headers).json()
    assert detail["entries"][0]["kt"] == "5010"

    xlsx = client.get(f"/api/analytics/trial-balance?company_id={harness.company.id}&from=2026-09-01&to=2026-09-30&format=xlsx", headers=headers)
    assert xlsx.status_code == 200 and xlsx.content[:2] == b"PK"
