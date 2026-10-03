from datetime import datetime

import pytest
from sqlalchemy import func, select

from app.models import Counterparty, Document, LedgerEntry
from app.services.sync import OPENING_REF, incremental_sync


@pytest.mark.both_transports
def test_full_sync_mirrors_catalogs_documents_entries_and_opening(harness, db):
    stats = harness.full_sync()
    assert stats["counterparties"] == 2
    assert stats["documents"] == 5
    cid = harness.company.id
    assert db.scalar(select(func.count()).select_from(Document).where(Document.company_id == cid)) == 5
    opening = db.scalars(select(LedgerEntry).where(LedgerEntry.company_id == cid, LedgerEntry.document_ref == OPENING_REF)).all()
    assert {(e.dt_account, str(e.amount)) for e in opening} == {("5010", "1000000.00"), ("2910", "500000.00")}
    buyer = db.scalar(select(Counterparty).where(Counterparty.inn == "123456789"))
    assert buyer.contract_refs[0]["number"] == "15"
    assert harness.company.sync_cursor
    assert harness.company.last_synced_at is not None


@pytest.mark.both_transports
def test_incremental_sync_picks_up_edits_and_new_documents(harness, db):
    harness.full_sync()
    fake = harness.fake
    sale = next(d for d in fake.documents.values() if d["type"] == "sale")
    sale["number"] = "EDITED"
    fake.post(sale)  # re-posting registers the change
    buyer = next(c for c in fake.counterparties.values() if c["inn"] == "123456789")
    contract = next(c for c in fake.contracts.values() if c["owner_ref"] == buyer["ref"])
    new = fake.add_document("bank_in", "2026-10-01", buyer, contract, amount=1000)

    calls_before = len(fake.calls)
    stats = incremental_sync(db, harness.company, harness.fetch())
    assert stats["documents"] == 2
    # Only the changed objects were requested, not the whole period.
    if harness.transport == "agent":
        assert all("from" not in params for cmd, params in fake.calls[calls_before:] if cmd == "get_documents")

    doc = db.scalar(select(Document).where(Document.ref_1c == sale["ref"]))
    assert doc.number == "EDITED"
    entries = db.scalars(select(LedgerEntry).where(LedgerEntry.document_ref == new["ref"])).all()
    assert [(e.dt_account, e.kt_account, str(e.amount)) for e in entries] == [("5110", "4010", "1000.00")]
    assert db.scalar(select(func.count()).select_from(LedgerEntry).where(LedgerEntry.document_ref == sale["ref"])) == 3


@pytest.mark.both_transports
def test_unposting_removes_entries_from_the_mirror(harness, db):
    harness.full_sync()
    sale = next(d for d in harness.fake.documents.values() if d["type"] == "sale")
    harness.fake.unpost(sale)
    incremental_sync(db, harness.company, harness.fetch())
    assert db.scalar(select(func.count()).select_from(LedgerEntry).where(LedgerEntry.document_ref == sale["ref"])) == 0
    assert db.scalar(select(Document.posted).where(Document.ref_1c == sale["ref"])) is False


def test_sync_job_skips_when_agent_offline(harness, db):
    from app.jobs import sync_company

    harness.gateway.online[harness.company.id] = False
    assert "skipped" in sync_company(harness.company.id)
    harness.gateway.online[harness.company.id] = True
    stats = sync_company(harness.company.id, full=True)
    assert stats["documents"] == 5
    db.expire_all()
    assert harness.company.last_synced_at <= datetime.now(harness.company.last_synced_at.tzinfo)
