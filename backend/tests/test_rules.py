"""Acceptance test D: plant one error per rule in a clean base -> exactly one finding for it."""

import pytest
from sqlalchemy import select

from app.models import AuditFinding
from app.services.audit.engine import RULES

pytestmark = pytest.mark.both_transports

ALL_RULES = [
    "CASH-NEG",
    "DUP-DOC",
    "DUP-CP",
    "NO-INN",
    "NO-IKPU",
    "VAT-RATE",
    "VAT-MISMATCH",
    "UNPOSTED",
    "ENTRY-MISMATCH",
    "NEG-STOCK",
    "OLD-DEBT",
    "NO-CONTRACT",
]


def findings(db, company_id):
    return list(db.scalars(select(AuditFinding).where(AuditFinding.company_id == company_id, AuditFinding.status == "open")))


def test_every_rule_is_registered():
    from app.services.audit import rules  # noqa: F401

    assert sorted(RULES) == sorted(ALL_RULES)


def test_clean_base_has_no_findings(harness, db):
    harness.full_sync()
    harness.audit()
    assert [(f.rule_code, f.message) for f in findings(db, harness.company.id)] == []


@pytest.mark.parametrize("rule_code", ALL_RULES)
def test_planted_error_gives_exactly_one_finding(make_harness, db, rule_code):
    h = make_harness(rule_code)
    h.full_sync()
    h.audit()
    found = findings(db, h.company.id)
    assert [f.rule_code for f in found] == [rule_code], [(f.rule_code, f.message) for f in found]
    assert found[0].message
    assert found[0].severity == RULES[rule_code].severity
    assert found[0].fix_type == RULES[rule_code].fix_type


def test_ignored_finding_stays_hidden_until_data_changes(make_harness, db):
    h = make_harness("NO-INN")
    h.full_sync()
    h.audit()
    finding = findings(db, h.company.id)[0]
    finding.status = "ignored"
    db.commit()

    h.audit()
    db.refresh(finding)
    assert finding.status == "ignored"

    cp = next(c for c in h.fake.counterparties.values() if c["inn"] == "12345")
    cp["inn"] = "1234"  # still wrong, but the data behind the finding changed
    h.fake._register("catalog", name="counterparties", ref=cp["ref"], deleted=False)
    from app.services.sync import incremental_sync

    incremental_sync(db, h.company, h.fetch())
    h.audit()
    db.refresh(finding)
    assert finding.status == "open"


def test_finding_closes_when_rule_stops_firing(make_harness, db):
    h = make_harness("NO-INN")
    h.full_sync()
    h.audit()
    finding = findings(db, h.company.id)[0]
    cp = next(c for c in h.fake.counterparties.values() if c["inn"] == "12345")
    cp["inn"] = "555666777"
    h.fake._register("catalog", name="counterparties", ref=cp["ref"], deleted=False)
    from app.services.sync import incremental_sync

    incremental_sync(db, h.company, h.fetch())
    h.audit()
    db.refresh(finding)
    assert finding.status == "fixed"


def test_closed_period_findings_get_the_note_and_no_fix(make_harness, db):
    from datetime import date

    h = make_harness("NO-CONTRACT")
    h.company.closed_period_until = date(2026, 9, 30)
    db.commit()
    h.fake.closed_until = date(2026, 9, 30)
    h.full_sync()
    h.audit()
    finding = findings(db, h.company.id)[0]
    assert finding.details["note"] == "correct in the current period"
    assert finding.fix_type is None
