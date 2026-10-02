"""Acceptance tests A: create/post/"send" 3 invoices (one via Excel); invalid INN blocked before 1C."""

import io
from decimal import Decimal

from openpyxl import Workbook

from app.models import Role
from tests.conftest import login, make_user


def _setup(client, harness, db):
    harness.full_sync()
    acc = make_user(db, "acc@example.com", Role.ACCOUNTANT, [harness.company.id])
    headers = login(client, acc.email)
    buyer = client.get(f"/api/companies/{harness.company.id}/counterparties?q=123456789", headers=headers).json()[0]
    water = client.get(f"/api/companies/{harness.company.id}/items?q=Вода", headers=headers).json()[0]
    return headers, buyer, water


def _lifecycle(client, headers, invoice_id, fake):
    r = client.post(f"/api/invoices/{invoice_id}/create-in-1c", headers=headers)
    assert r.status_code == 200, r.text
    inv = client.get(f"/api/invoices/{invoice_id}", headers=headers).json()
    assert inv["status"] == "created" and inv["number"] and inv["ref_1c"]
    doc = fake.documents[inv["ref_1c"]]
    assert doc["posted"] is False
    assert Decimal(doc["amount"]) == Decimal(inv["total"]) and Decimal(doc["vat"]) == Decimal(inv["vat"])

    client.post(f"/api/invoices/{invoice_id}/post", headers=headers)
    assert client.get(f"/api/invoices/{invoice_id}", headers=headers).json()["status"] == "posted"
    assert doc["posted"] is True

    sent = client.post(f"/api/invoices/{invoice_id}/send", headers=headers).json()
    assert sent["status"] == "ready"  # stub operator: marked ready to send
    return inv


def test_form_invoice_lifecycle_and_copy(client, harness, db):
    headers, buyer, water = _setup(client, harness, db)
    draft = client.post(
        "/api/invoices",
        json={
            "company_id": harness.company.id,
            "date": "2026-10-02",
            "buyer_ref": buyer["ref_1c"],
            "contract_ref": buyer["contracts"][0]["ref"],
            "rows": [{"item_ref": water["ref_1c"], "quantity": 3}],
        },
        headers=headers,
    ).json()
    # Autofill from items: unit, price, VAT rate, IKPU.
    row = draft["rows"][0]
    assert (row["unit"], row["price"], row["vat_rate"], row["ikpu_code"]) == ("шт", "10000.00", "12.00", water["ikpu_code"])
    assert draft["total"] == "33600.00" and draft["vat"] == "3600.00"
    assert draft["errors"] == []
    assert not [c for c in harness.fake.calls if c[0] == "create_invoice"]  # draft never reaches 1C

    _lifecycle(client, headers, draft["id"], harness.fake)

    copy = client.post(f"/api/invoices/{draft['id']}/copy", headers=headers).json()
    assert copy["status"] == "draft" and copy["rows"][0]["item_ref"] == water["ref_1c"]
    _lifecycle(client, headers, copy["id"], harness.fake)


def test_excel_bulk_invoice(client, harness, db):
    headers, buyer, water = _setup(client, harness, db)
    wb = Workbook()
    ws = wb.active
    ws.append(["invoice_no", "date", "buyer_inn", "contract_number", "item", "quantity", "price"])
    ws.append(["A1", "2026-10-02", "123456789", "15", water["ikpu_code"], 2, 10000])
    ws.append(["A1", "2026-10-02", "123456789", "15", "Вода питьевая 19л", 1, ""])
    ws.append(["B2", "2026-10-02", "999", "", "Нет такого товара", 1, 1])
    buf = io.BytesIO()
    wb.save(buf)

    preview = client.post(
        f"/api/invoices/bulk/preview?company_id={harness.company.id}",
        files={"file": ("inv.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        headers=headers,
    ).json()
    good, bad = preview
    assert good["errors"] == [] and good["total"] == "33600.00"
    assert {e["field"] for e in bad["errors"]} >= {"item", "buyer_inn"}

    created = client.post(
        "/api/invoices/bulk/create",
        json={"company_id": harness.company.id, "invoices": [{k: good[k] for k in ("date", "buyer_ref", "contract_ref", "rows")}]},
        headers=headers,
    ).json()
    assert created[0]["status"] == "created"
    client.post(f"/api/invoices/{created[0]['id']}/post", headers=headers)
    assert client.post(f"/api/invoices/{created[0]['id']}/send", headers=headers).json()["status"] == "ready"


def test_invalid_inn_is_blocked_before_1c(client, harness, db):
    headers, buyer, water = _setup(client, harness, db)
    bad_cp = next(c for c in harness.fake.counterparties.values() if c["inn"] == "123456789")
    bad_cp["inn"] = "12345"
    harness.fake._register("catalog", name="counterparties", ref=bad_cp["ref"], deleted=False)
    from app.services.sync import incremental_sync

    incremental_sync(db, harness.company, harness.fetch())
    draft = client.post(
        "/api/invoices",
        json={"company_id": harness.company.id, "buyer_ref": buyer["ref_1c"], "contract_ref": buyer["contracts"][0]["ref"],
              "rows": [{"item_ref": water["ref_1c"], "quantity": 1}]},
        headers=headers,
    ).json()
    assert any(e["field"] == "buyer_inn" for e in draft["errors"])
    r = client.post(f"/api/invoices/{draft['id']}/create-in-1c", headers=headers)
    assert r.status_code == 422
    assert not [c for c in harness.fake.calls if c[0] == "create_invoice"]


def test_three_invoices_numbers_and_totals_match_1c(client, harness, db):
    headers, buyer, water = _setup(client, harness, db)
    for qty in (1, 2, 3):
        draft = client.post(
            "/api/invoices",
            json={"company_id": harness.company.id, "buyer_ref": buyer["ref_1c"], "contract_ref": buyer["contracts"][0]["ref"],
                  "rows": [{"item_ref": water["ref_1c"], "quantity": qty}]},
            headers=headers,
        ).json()
        _lifecycle(client, headers, draft["id"], harness.fake)
    listed = client.get(f"/api/invoices?company_id={harness.company.id}", headers=headers).json()
    assert len({i["number"] for i in listed}) == 3
