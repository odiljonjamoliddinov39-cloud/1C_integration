"""Acceptance tests C: approve a VAT-RATE fix then undo it; closed period refused with 409; offline queue."""

from datetime import date

from sqlalchemy import select

from app.models import AuditFinding, EventLog, Role
from tests.conftest import login, make_user


def _finding(db, rule):
    return db.scalar(select(AuditFinding).where(AuditFinding.rule_code == rule))


def test_vat_rate_fix_then_undo(client, make_harness, db):
    h = make_harness("VAT-RATE")
    h.full_sync()
    h.audit()
    acc = make_user(db, "acc@example.com", Role.ACCOUNTANT, [h.company.id])
    headers = login(client, acc.email)
    finding = _finding(db, "VAT-RATE")
    sale = h.fake.documents[finding.object_ref]

    r = client.post("/api/fixes", json={"finding_id": finding.id}, headers=headers)
    assert r.status_code == 200, r.text
    fix = r.json()
    assert fix["status"] == "proposed"
    assert fix["preview"]["current"]["rows"][0]["vat_rate"] == 15
    assert fix["preview"]["proposed"]["rows"] == [{"row": 1, "item_ref": sale["rows"][0]["item_ref"], "vat_rate": 12.0}]
    assert fix["preview"]["affected_entries"]
    assert sale["rows"][0]["vat_rate"] == 15  # nothing changes before approval

    r = client.post("/api/fixes/approve", json={"fix_ids": [fix["id"]]}, headers=headers)
    applied = r.json()[0]
    assert applied["status"] == "applied", applied
    assert applied["approval_id"]
    assert applied["before"] == {"rows": [{"row": 1, "vat_rate": 15}]}
    assert sale["rows"][0]["vat_rate"] == 12.0  # 1C shows the change
    db.expire_all()
    assert _finding(db, "VAT-RATE").status == "fixed"

    undo = client.post(f"/api/fixes/{fix['id']}/undo", json={}, headers=headers).json()
    assert undo["fix_type"] == "restore" and undo["reverses_fix_id"] == fix["id"]
    r = client.post("/api/fixes/approve", json={"fix_ids": [undo["id"]]}, headers=headers)
    assert r.json()[0]["status"] == "applied"
    assert sale["rows"][0]["vat_rate"] == 15  # original values back

    # Both writes logged in the backend and in 1C (ЖурналИзмененийAI).
    actions = [e.action for e in db.scalars(select(EventLog).order_by(EventLog.id))]
    assert actions.count("fix.applied") == 2
    assert len(h.fake.journal) == 2
    db.expire_all()
    assert _finding(db, "VAT-RATE").status == "open"


def test_fix_in_closed_period_is_refused_and_nothing_changes(client, make_harness, db):
    h = make_harness("NO-CONTRACT")
    h.full_sync()
    h.audit()
    acc = make_user(db, "acc@example.com", Role.ACCOUNTANT, [h.company.id])
    headers = login(client, acc.email)
    finding = _finding(db, "NO-CONTRACT")
    contract = next(c for c in h.fake.contracts.values() if c["number"] == "15")
    fix = client.post("/api/fixes", json={"finding_id": finding.id, "params": {"value": contract["ref"]}}, headers=headers).json()

    # The period gets closed in 1C after the proposal; 1C must refuse with 409.
    h.fake.closed_until = date(2026, 9, 30)
    before = dict(h.fake.documents[finding.object_ref])
    applied = client.post("/api/fixes/approve", json={"fix_ids": [fix["id"]]}, headers=headers).json()[0]
    assert applied["status"] == "failed"
    assert applied["result"].startswith("closed_period")
    assert h.fake.documents[finding.object_ref] == before

    # Once the backend knows the period is closed it refuses up front with 409.
    h.company.closed_period_until = date(2026, 9, 30)
    db.commit()
    r = client.post("/api/fixes", json={"finding_id": finding.id, "params": {"value": contract["ref"]}}, headers=headers)
    assert r.status_code == 409


def test_bulk_approve_limits(client, make_harness, db):
    h = make_harness("NO-INN")
    h.full_sync()
    h.audit()
    acc = make_user(db, "acc@example.com", Role.ACCOUNTANT, [h.company.id])
    headers = login(client, acc.email)
    r = client.post("/api/fixes/approve", json={"fix_ids": list(range(1, 52))}, headers=headers)
    assert r.status_code in (400, 404)
    finding = _finding(db, "NO-INN")
    bad = client.post("/api/fixes", json={"finding_id": finding.id, "params": {"value": "12"}}, headers=headers)
    assert bad.status_code == 400  # INN must be 9 or 14 digits
    fix = client.post("/api/fixes", json={"finding_id": finding.id, "params": {"value": "555666777"}}, headers=headers).json()
    out = client.post("/api/fixes/approve", json={"fix_ids": [fix["id"]]}, headers=headers).json()
    assert out[0]["status"] == "applied"
    assert any(c["inn"] == "555666777" for c in h.fake.counterparties.values())


def test_writes_wait_in_queue_while_agent_offline(client, make_harness, db):
    h = make_harness("VAT-RATE")
    h.full_sync()
    h.audit()
    acc = make_user(db, "acc@example.com", Role.ACCOUNTANT, [h.company.id])
    headers = login(client, acc.email)
    fix = client.post("/api/fixes", json={"finding_id": _finding(db, "VAT-RATE").id}, headers=headers).json()

    h.gateway.online[h.company.id] = False
    out = client.post("/api/fixes/approve", json={"fix_ids": [fix["id"]]}, headers=headers).json()
    assert out[0]["status"] == "approved"  # queued, not applied
    # Reads come from the mirror meanwhile.
    assert client.get("/api/analytics/dashboard", headers=headers).status_code == 200

    h.gateway.reconnect(h.company.id)
    assert client.get(f"/api/fixes/{fix['id']}", headers=headers).json()["status"] == "applied"


def test_merge_and_reverse_duplicate(client, make_harness, db):
    for rule in ("DUP-CP", "DUP-DOC"):
        h = make_harness(rule)
        h.full_sync()
        h.audit()
        finding = _finding(db, rule)
        email = f"{rule.lower()}@example.com"
        make_user(db, email, Role.OWNER)
        headers = login(client, email)
        fix = client.post("/api/fixes", json={"finding_id": finding.id}, headers=headers).json()
        out = client.post("/api/fixes/approve", json={"fix_ids": [fix["id"]]}, headers=headers).json()[0]
        assert out["status"] == "applied", out
        db.expire_all()
        assert _finding(db, rule).status == "fixed"
        db.query(AuditFinding).delete()
        db.commit()
