"""Direct (OData) connection: the Connect 1C form, sync without an agent, offline 1C, and limits."""

import httpx
import pytest
from sqlalchemy import func, select

from app.models import Company, Document, OneCConnection, Role
from app.security import decrypt_secret
from app.services import agent_gateway
from app.services.connections import RoutingGateway
from app.services.odata import odata_url
from tests.conftest import login, make_user
from tests.fake_1c import clean_base
from tests.fake_odata import FakeODataServer

FORM = {"address": "fake-1c", "base": "TEST_CRYSTAL", "username": "odata", "password": "secret"}


def _no_agent(company_id, command, params):
    return {"ok": False, "status": 503, "error": {"error": "offline", "message": "no agent", "details": {}}}


@pytest.fixture
def direct(db):
    """A 1C base reachable only over OData (no agent), and an owner who connects it."""
    from app.jobs import command_callback

    fake = clean_base()
    server = FakeODataServer({"TEST_CRYSTAL": fake})
    local = agent_gateway.LocalAgentGateway(_no_agent, on_callback=command_callback)
    agent_gateway.set_gateway(RoutingGateway(local, transport_factory=lambda company_id: server.transport()))
    make_user(db, "owner@example.com", Role.OWNER)
    yield fake
    agent_gateway.set_gateway(None)


def test_odata_url_accepts_ip_host_or_full_url():
    assert odata_url("192.168.1.10", "TEST_CRYSTAL") == "http://192.168.1.10/TEST_CRYSTAL/odata/standard.odata/"
    assert odata_url("srv:8080/", "/BASE/") == "http://srv:8080/BASE/odata/standard.odata/"
    assert odata_url("https://1c.example.uz/BASE/odata/standard.odata/") == "https://1c.example.uz/BASE/odata/standard.odata/"
    for bad in ("", "ftp://x/BASE", "192.168.1.10"):
        with pytest.raises(ValueError):
            odata_url(bad)


def test_connect_form_tests_creates_company_and_syncs(client, db, direct):
    headers = login(client, "owner@example.com")

    wrong = client.post("/api/admin/onec/test", json={**FORM, "password": "nope"}, headers=headers).json()
    assert wrong["ok"] is False and "password" in wrong["error"]
    missing = client.post("/api/admin/onec/test", json={**FORM, "base": "NO_SUCH_BASE"}, headers=headers).json()
    assert missing["ok"] is False and "OData" in missing["error"]

    ok = client.post("/api/admin/onec/test", json=FORM, headers=headers).json()
    assert ok["ok"] is True, ok
    assert ok["organizations"][0]["inn"] == "300000001"
    assert ok["missing"] == ["Document_ОперацияБух"]  # reported, sync works without it

    r = client.post("/api/admin/companies/connect", json=FORM, headers=headers)
    assert r.status_code == 200, r.text
    created = r.json()
    assert created["connection_type"] == "odata" and created["inn"] == "300000001"
    assert created["direct"]["address"] == "http://fake-1c/TEST_CRYSTAL" and "password" not in str(created["direct"])
    cid = created["id"]
    assert db.scalar(select(func.count()).select_from(Document).where(Document.company_id == cid)) == 5  # full sync ran

    stored = db.get(OneCConnection, cid)
    assert stored.password_enc != "secret" and decrypt_secret(stored.password_enc) == "secret"
    listed = next(c for c in client.get("/api/companies", headers=headers).json() if c["id"] == cid)
    assert listed["agent_online"] is True and listed["connection_type"] == "odata"

    # Editing keeps the stored password when the field is left empty.
    r = client.post(f"/api/admin/companies/{cid}/connection", json={**FORM, "password": ""}, headers=headers)
    assert r.status_code == 200, r.text

    # The same base cannot be attached to a company with another INN.
    other = client.post("/api/admin/companies", json={"name": "Other", "inn": "111111111"}, headers=headers).json()
    r = client.post(f"/api/admin/companies/{other['id']}/connection", json=FORM, headers=headers)
    assert r.status_code == 409 and "300000001" in r.json()["detail"]

    # Back to the agent: the address and password are deleted.
    r = client.delete(f"/api/admin/companies/{cid}/connection", headers=headers)
    assert r.json()["connection_type"] == "agent"
    db.expire_all()
    assert db.get(OneCConnection, cid) is None


def test_incremental_sync_finds_changes_by_data_version(client, db, direct):
    from app.jobs import sync_company

    headers = login(client, "owner@example.com")
    cid = client.post("/api/admin/companies/connect", json=FORM, headers=headers).json()["id"]
    fake = direct
    buyer = next(c for c in fake.counterparties.values() if c["inn"] == "123456789")
    contract = next(c for c in fake.contracts.values() if c["owner_ref"] == buyer["ref"])
    new = fake.add_document("bank_in", "2026-10-01", buyer, contract, amount=1000)
    buyer["name"] = "ООО Покупатель (новое имя)"
    gone = next(d for d in fake.documents.values() if d["type"] == "purchase")
    del fake.documents[gone["ref"]]
    fake.entries.pop(gone["ref"], None)

    stats = sync_company(cid)
    assert stats["changes"] == 3, stats
    db.expire_all()
    assert db.scalar(select(Document.amount).where(Document.ref_1c == new["ref"])) == 1000
    assert db.scalar(select(Document.deleted).where(Document.ref_1c == gone["ref"])) is True
    assert sync_company(cid)["changes"] == 0


def test_unreachable_1c_is_offline_and_sync_is_skipped(client, db, direct):
    from app.jobs import sync_company

    headers = login(client, "owner@example.com")
    cid = client.post("/api/admin/companies/connect", json=FORM, headers=headers).json()["id"]

    def down(request):
        raise httpx.ConnectError("No route to host")

    gateway = agent_gateway.get_gateway()
    gateway.transport_factory = lambda company_id: httpx.MockTransport(down)
    gateway.forget(cid)

    assert "skipped" in sync_company(cid)
    listed = next(c for c in client.get("/api/companies", headers=headers).json() if c["id"] == cid)
    assert listed["agent_online"] is False
    assert client.get(f"/api/onec/{cid}/objects/catalog/Контрагенты", headers=headers).status_code == 503
    test = client.post("/api/admin/onec/test", json=FORM, headers=headers).json()
    assert test["ok"] is False and "Cannot reach" in test["error"]


@pytest.mark.parametrize("transport", ["odata"])
def test_query_needs_the_extension(client, harness, db, transport):
    harness.full_sync()
    acc = make_user(db, "acc@example.com", Role.ACCOUNTANT, [harness.company.id])
    r = client.post(f"/api/onec/{harness.company.id}/query", json={"text": "ВЫБРАТЬ 1"}, headers=login(client, acc.email))
    assert r.status_code == 501 and "extension" in r.json()["detail"]["message"]
    assert db.get(Company, harness.company.id).connection_type == "odata"
