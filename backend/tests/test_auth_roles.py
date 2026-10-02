"""Acceptance test E: a Viewer assigned to one company sees only it and cannot write (403)."""

import pyotp

from app.models import Role
from tests.conftest import login, make_user
from tests.fake_1c import clean_base


def test_login_and_session(client, db):
    make_user(db, "owner@example.com", Role.OWNER)
    r = client.post("/api/auth/login", json={"email": "owner@example.com", "password": "wrong password"})
    assert r.status_code == 401
    headers = login(client, "owner@example.com")
    assert client.get("/api/auth/me", headers=headers).json()["role"] == "owner"
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_viewer_sees_only_assigned_company_and_cannot_write(client, harness, db):
    other = harness.add_company("TEXMASH", clean_base())
    harness.full_sync()
    harness.full_sync(other)
    harness.audit()
    viewer = make_user(db, "brother@example.com", Role.VIEWER, [harness.company.id])
    headers = login(client, viewer.email)

    companies = client.get("/api/companies", headers=headers).json()
    assert [c["id"] for c in companies] == [harness.company.id]

    # Combined view only covers the viewer's company.
    dash = client.get("/api/analytics/dashboard", headers=headers).json()
    assert dash["company_ids"] == [harness.company.id]
    assert client.get(f"/api/analytics/dashboard?company_id={other.id}", headers=headers).status_code == 403
    docs = client.get("/api/documents", headers=headers).json()
    assert {d["company_id"] for d in docs} == {harness.company.id}
    assert client.get(f"/api/documents?company_id={other.id}", headers=headers).status_code == 403

    # Every write is refused.
    assert client.post("/api/invoices", json={"company_id": harness.company.id}, headers=headers).status_code == 403
    assert client.post("/api/fixes/approve", json={"fix_ids": [1]}, headers=headers).status_code == 403
    assert client.post("/api/fixes", json={"finding_id": 1}, headers=headers).status_code == 403
    assert client.post(f"/api/companies/{harness.company.id}/sync", headers=headers).status_code == 403
    assert client.get("/api/admin/users", headers=headers).status_code == 403


def test_accountant_cannot_manage_users(client, harness, db):
    acc = make_user(db, "acc@example.com", Role.ACCOUNTANT, [harness.company.id])
    headers = login(client, acc.email)
    assert client.get("/api/admin/users", headers=headers).status_code == 403
    assert client.post(f"/api/admin/companies/{harness.company.id}/agents", headers=headers).status_code == 403


def test_owner_manages_users_and_agent_tokens(client, harness, db):
    make_user(db, "owner@example.com", Role.OWNER)
    headers = login(client, "owner@example.com")
    r = client.post(
        "/api/admin/users",
        json={"email": "new@example.com", "password": "long enough pw", "role": "viewer", "company_ids": [harness.company.id]},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["company_ids"] == [harness.company.id]

    first = client.post(f"/api/admin/companies/{harness.company.id}/agents", headers=headers).json()
    second = client.post(f"/api/admin/companies/{harness.company.id}/agents", headers=headers).json()
    assert first["token"] != second["token"]
    agents = client.get(f"/api/admin/companies/{harness.company.id}/agents", headers=headers).json()
    assert [a["revoked"] for a in agents] == [True, False]  # one live token per company


def test_owner_totp(client, db):
    make_user(db, "owner@example.com", Role.OWNER)
    headers = login(client, "owner@example.com")
    secret = client.post("/api/auth/totp/setup", headers=headers).json()["secret"]
    assert client.post("/api/auth/totp/enable", json={"code": "000000"}, headers=headers).status_code == 400
    assert client.post("/api/auth/totp/enable", json={"code": pyotp.TOTP(secret).now()}, headers=headers).status_code == 200
    r = client.post("/api/auth/login", json={"email": "owner@example.com", "password": "correct horse battery"})
    assert r.json()["detail"] == "totp_required"
    r = client.post("/api/auth/login", json={"email": "owner@example.com", "password": "correct horse battery", "totp": pyotp.TOTP(secret).now()})
    assert r.status_code == 200
