from app.models import Role
from tests.conftest import login, make_user


def test_monthly_audit_report_pdf(client, make_harness, db):
    h = make_harness("CASH-NEG")
    h.full_sync()
    h.audit()
    make_user(db, "owner@example.com", Role.OWNER)
    r = client.get(f"/api/companies/{h.company.id}/audit-report.pdf", headers=login(client, "owner@example.com"))
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:4] == b"%PDF"

    from app.services.report import report_data
    from datetime import date

    data = report_data(db, h.company, f"{date.today():%Y-%m}")
    assert data["by_severity"]["critical"]["open"] == 1
