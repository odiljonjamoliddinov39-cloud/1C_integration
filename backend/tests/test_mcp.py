"""Acceptance test AI: questions about all companies over MCP; a Viewer token cannot reach write tools."""

import json

from app.models import Role
from tests.conftest import login, make_user
from tests.fake_1c import clean_base


def _rpc(client, token, method, params=None, msg_id=1):
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}}, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    return r.json()


def _mcp_token(client, email):
    return client.post("/api/auth/mcp-token", headers=login(client, email)).json()["token"]


def test_mcp_owner_reads_all_companies(client, harness, db, monkeypatch):
    other = harness.add_company("TEXMASH", clean_base())
    harness.full_sync()
    harness.full_sync(other)
    make_user(db, "owner@example.com", Role.OWNER)
    token = _mcp_token(client, "owner@example.com")

    init = _rpc(client, token, "initialize", {"protocolVersion": "2025-06-18"})
    assert init["result"]["serverInfo"]["name"] == "1c-integration"
    names = {t["name"] for t in _rpc(client, token, "tools/list")["result"]["tools"]}
    assert {"query_books", "dashboard", "propose_fix"} <= names

    import os

    from sqlalchemy import create_engine

    from app.services import ai

    ro = create_engine(os.environ["READONLY_DATABASE_URL"])
    monkeypatch.setattr(ai, "_readonly_engine", lambda: ro)
    out = _rpc(client, token, "tools/call", {"name": "query_books", "arguments": {"sql": "SELECT c.name FROM companies c ORDER BY c.id"}})
    assert out["result"]["isError"] is False
    assert json.loads(out["result"]["content"][0]["text"])["rows"] == [["TEST_CRYSTAL"], ["TEXMASH"]]

    dash = _rpc(client, token, "tools/call", {"name": "dashboard", "arguments": {"date": "2026-10-02"}})
    assert json.loads(dash["result"]["content"][0]["text"])["cash_bank"]["cash"]["balance"] == "1440000.00"


def test_mcp_viewer_cannot_reach_write_tools(client, make_harness, db):
    h = make_harness("NO-INN")
    h.full_sync()
    h.audit()
    make_user(db, "viewer@example.com", Role.VIEWER, [h.company.id])
    token = _mcp_token(client, "viewer@example.com")
    names = {t["name"] for t in _rpc(client, token, "tools/list")["result"]["tools"]}
    assert "propose_fix" not in names and "create_invoice_draft" not in names
    out = _rpc(client, token, "tools/call", {"name": "propose_fix", "arguments": {"finding_id": 1, "value": "123456789"}})
    assert out["result"]["isError"] is True


def test_mcp_rejects_bad_token(client):
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401
