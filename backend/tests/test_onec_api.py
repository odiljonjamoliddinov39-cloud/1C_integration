"""Direct 1C API: metadata, any object, 1C queries, approval-gated changes, and the right-base guard."""

import json
from datetime import date

import pytest
from sqlalchemy import select

from app.models import Counterparty, Document, Role
from tests.conftest import login, make_user

UNKNOWN = "00000000-0000-0000-0000-000000000000"


def _setup(client, harness, db, role=Role.ACCOUNTANT):
    harness.full_sync()
    user = make_user(db, f"{role}@example.com", role, [harness.company.id])
    return login(client, user.email), f"/api/onec/{harness.company.id}"


@pytest.mark.both_transports
def test_metadata_and_reads(client, harness, db):
    headers, base = _setup(client, harness, db, Role.VIEWER)
    meta = client.get(f"{base}/metadata", headers=headers).json()
    assert "Контрагенты" in [c["name"] for c in meta["catalogs"]]
    assert "РеализацияТоваровУслуг" in [d["name"] for d in meta["documents"]]

    cps = client.get(f"{base}/objects/catalog/Контрагенты", params={"filter": json.dumps({"ИНН": "123456789"})}, headers=headers).json()
    assert [c["standard"]["Наименование"] for c in cps["items"]] == ["ООО Покупатель"]

    sale = client.get(f"{base}/objects/document/РеализацияТоваровУслуг", params={"from": "2026-09-01", "to": "2026-09-30"}, headers=headers).json()["items"][0]
    one = client.get(f"{base}/objects/document/РеализацияТоваровУслуг/{sale['ref']}", headers=headers).json()
    water = next(i for i in harness.fake.items.values() if i["name"].startswith("Вода"))
    assert one["tables"]["Товары"][0]["Номенклатура"]["ref"] == water["ref"]
    assert one["tables"]["Товары"][0]["Номенклатура"]["_type"] == "Справочник.Номенклатура"
    if harness.transport == "agent":  # OData returns references without their presentation
        assert one["tables"]["Товары"][0]["Номенклатура"]["presentation"] == "Вода питьевая 19л"
    assert one["attributes"]["Контрагент"]["_type"] == "Справочник.Контрагенты"

    assert client.get(f"{base}/objects/catalog/Контрагенты/{UNKNOWN}", headers=headers).status_code == 404
    assert client.get(f"{base}/objects/catalog/Контрагенты/not-a-uuid", headers=headers).status_code == 400
    assert client.get(f"{base}/objects/catalog/Bad;Name", headers=headers).status_code == 400
    assert client.get(f"{base}/objects/robots/Контрагенты", headers=headers).status_code == 400


def test_query_is_for_owners_and_accountants(client, harness, db):
    headers, base = _setup(client, harness, db)
    text = "ВЫБРАТЬ Счет, СуммаОстатокДт, СуммаОстатокКт ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата)"
    out = client.post(f"{base}/query", json={"text": text, "params": {"Дата": "2026-10-02"}}, headers=headers).json()
    balances = {r[0]: r for r in out["rows"]}
    assert balances["5010"][1] == 720000.0
    assert harness.fake.queries[-1][0] == text

    viewer = make_user(db, "v@example.com", Role.VIEWER, [harness.company.id])
    assert client.post(f"{base}/query", json={"text": text}, headers=login(client, viewer.email)).status_code == 403


@pytest.mark.both_transports
def test_update_is_approved_applied_resynced_and_undone(client, harness, db):
    headers, base = _setup(client, harness, db)
    buyer = next(c for c in harness.fake.counterparties.values() if c["inn"] == "123456789")

    proposal = client.post(
        f"{base}/changes",
        json={"kind": "catalog", "name": "Контрагенты", "action": "update", "ref": buyer["ref"], "data": {"attributes": {"ИНН": "555666777"}}},
        headers=headers,
    ).json()
    assert proposal["status"] == "proposed" and proposal["fix_type"] == "object_write"
    assert proposal["preview"]["current"]["attributes"]["ИНН"] == "123456789"
    assert buyer["inn"] == "123456789"  # nothing changed before approval

    applied = client.post("/api/fixes/approve", json={"fix_ids": [proposal["id"]]}, headers=headers).json()[0]
    assert applied["status"] == "applied", applied
    assert buyer["inn"] == "555666777"
    assert applied["before"]["attributes"]["ИНН"] == "123456789"
    db.expire_all()
    assert db.scalar(select(Counterparty.inn).where(Counterparty.ref_1c == buyer["ref"])) == "555666777"  # mirror re-synced

    undo = client.post(f"/api/fixes/{proposal['id']}/undo", json={}, headers=headers).json()
    client.post("/api/fixes/approve", json={"fix_ids": [undo["id"]]}, headers=headers)
    assert buyer["inn"] == "123456789"
    if harness.transport == "agent":
        assert len(harness.fake.journal) == 2


@pytest.mark.both_transports
def test_create_and_post_document_then_undo(client, harness, db):
    headers, base = _setup(client, harness, db)
    fake = harness.fake
    buyer = next(c for c in fake.counterparties.values() if c["inn"] == "123456789")
    contract = next(c for c in fake.contracts.values() if c["owner_ref"] == buyer["ref"])
    water = next(i for i in fake.items.values() if i["name"].startswith("Вода"))
    data = {
        "standard": {"Дата": "2026-10-02T12:00:00"},
        "attributes": {
            "Контрагент": {"_type": "Справочник.Контрагенты", "ref": buyer["ref"]},
            "ДоговорКонтрагента": {"_type": "Справочник.ДоговорыКонтрагентов", "ref": contract["ref"]},
        },
        "tables": {"Товары": [{"Номенклатура": {"_type": "Справочник.Номенклатура", "ref": water["ref"]}, "Количество": 2, "Цена": 10000, "СтавкаНДС": 12}]},
    }
    proposal = client.post(
        f"{base}/changes", json={"kind": "document", "name": "РеализацияТоваровУслуг", "action": "create", "data": data, "post": True}, headers=headers
    ).json()
    applied = client.post("/api/fixes/approve", json={"fix_ids": [proposal["id"]]}, headers=headers).json()[0]
    assert applied["status"] == "applied", applied
    new_ref = applied["after"]["ref"]
    assert fake.documents[new_ref]["posted"] is True and fake.documents[new_ref]["amount"] == "22400.00"
    db.expire_all()
    assert db.scalar(select(Document.amount).where(Document.ref_1c == new_ref)) is not None  # mirrored

    undo = client.post(f"/api/fixes/{proposal['id']}/undo", json={}, headers=headers).json()
    assert undo["proposed_change"]["changes"]["action"] == "mark_deletion"
    client.post("/api/fixes/approve", json={"fix_ids": [undo["id"]]}, headers=headers)
    assert fake.documents[new_ref]["deleted"] is True and fake.documents[new_ref]["posted"] is False


@pytest.mark.both_transports
def test_closed_period_and_validation(client, harness, db):
    headers, base = _setup(client, harness, db)
    harness.company.closed_period_until = date(2026, 9, 30)
    db.commit()
    sale = next(d for d in harness.fake.documents.values() if d["type"] == "sale")
    r = client.post(f"{base}/changes", json={"kind": "document", "name": "РеализацияТоваровУслуг", "action": "unpost", "ref": sale["ref"]}, headers=headers)
    assert r.status_code == 409
    bad = [
        {"kind": "accounting_register", "name": "Хозрасчетный", "action": "update", "ref": sale["ref"], "data": {"attributes": {"X": 1}}},
        {"kind": "catalog", "name": "Контрагенты", "action": "post", "ref": sale["ref"]},
        {"kind": "catalog", "name": "Контрагенты", "action": "update", "ref": sale["ref"], "data": {"evil": {}}},
        {"kind": "catalog", "name": "Контрагенты", "action": "create"},
    ]
    for body in bad:
        assert client.post(f"{base}/changes", json=body, headers=headers).status_code == 400, body


@pytest.mark.both_transports
def test_wrong_base_blocks_sync_reads_and_writes(client, harness, db):
    from app.jobs import sync_company

    headers, base = _setup(client, harness, db)
    buyer = next(c for c in harness.fake.counterparties.values() if c["inn"] == "123456789")
    proposal = client.post(
        f"{base}/changes",
        json={"kind": "catalog", "name": "Контрагенты", "action": "update", "ref": buyer["ref"], "data": {"attributes": {"ИНН": "555666777"}}},
        headers=headers,
    ).json()

    # The agent token now points at another company's base.
    harness.fake.inn = "999999999"
    from app.services.onec import forget_verification

    forget_verification()
    assert "skipped" in sync_company(harness.company.id)
    db.expire_all()
    assert "wrong 1C base" in harness.company.base_error
    assert client.get(f"{base}/metadata", headers=headers).status_code == 409
    assert client.post("/api/fixes/approve", json={"fix_ids": [proposal["id"]]}, headers=headers).status_code == 409
    assert buyer["inn"] == "123456789"
    assert client.get("/api/companies", headers=headers).json()[0]["base_error"]
    create = {"kind": "catalog", "name": "Номенклатура", "action": "create", "data": {"standard": {"Наименование": "X"}}}
    assert client.post(f"{base}/changes", json=create, headers=headers).status_code == 409

    # Back on the right base: the guard clears itself on the next check.
    harness.fake.inn = "300000001"
    assert client.get(f"{base}/metadata", headers=headers).status_code == 200
    db.expire_all()
    assert harness.company.base_error is None


@pytest.mark.both_transports
def test_mcp_onec_tools(client, harness, db):
    harness.full_sync()
    make_user(db, "owner@example.com", Role.OWNER)
    make_user(db, "viewer@example.com", Role.VIEWER, [harness.company.id])

    def rpc(email, method, params=None):
        token = client.post("/api/auth/mcp-token", headers=login(client, email)).json()["token"]
        r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, headers={"Authorization": f"Bearer {token}"})
        return r.json()["result"]

    viewer_tools = {t["name"] for t in rpc("viewer@example.com", "tools/list")["tools"]}
    assert "onec_metadata" in viewer_tools and "onec_query" not in viewer_tools and "onec_propose_change" not in viewer_tools

    out = rpc("owner@example.com", "tools/call", {"name": "onec_list_objects", "arguments": {"company_id": harness.company.id, "kind": "catalog", "name": "Номенклатура"}})
    assert out["isError"] is False
    assert len(json.loads(out["content"][0]["text"])["items"]) == 2
    out = rpc("viewer@example.com", "tools/call", {"name": "onec_query", "arguments": {"company_id": harness.company.id, "text": "ВЫБРАТЬ 1"}})
    assert out["isError"] is True
