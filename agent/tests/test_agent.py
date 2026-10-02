import asyncio
import json

import httpx
import pytest
from websockets.asyncio.server import serve

from onec_agent import connection as conn_module
from onec_agent.config import AgentConfig, load_configs
from onec_agent.connection import AgentConnection
from onec_agent.extension import REF_CHUNK, ExtensionClient


def fake_extension(log: list):
    """A mock 1C HTTP service following docs/api-contract.md."""

    def handler(request: httpx.Request) -> httpx.Response:
        log.append((request.method, request.url.path, dict(request.url.params), request.content))
        if request.headers.get("authorization") != "Bearer ext-token":
            return httpx.Response(401, json={"error": "unauthorized", "message": "bad token", "details": {}})
        path = request.url.path.removeprefix("/TEST/hs/aiapi/v1")
        if path == "/ping":
            return httpx.Response(200, json={"version": "1.0.0", "base_name": "TEST_CRYSTAL"})
        if path.startswith("/documents/"):
            refs = request.url.params.get("refs", "")
            return httpx.Response(200, json={"type": "sale", "items": [{"ref": r} for r in refs.split(",") if r]})
        if path == "/fixes":
            body = json.loads(request.content)
            if body.get("closed"):
                return httpx.Response(409, json={"error": "closed_period", "message": "Period is closed", "details": {}})
            return httpx.Response(200, json={"before": {"x": 1}, "after": {"x": 2}})
        return httpx.Response(404, json={"error": "not_found", "message": path, "details": {}})

    return handler


def client(log):
    return ExtensionClient("http://127.0.0.1/TEST/hs/aiapi/v1", "ext-token", transport=httpx.MockTransport(fake_extension(log)))


def test_commands_map_to_extension_endpoints():
    log = []
    ext = client(log)
    assert ext.execute("ping", {}) == {"ok": True, "data": {"version": "1.0.0", "base_name": "TEST_CRYSTAL"}}
    reply = ext.execute("apply_fix", {"approval_id": "a1", "type": "repost", "approved_by": "acc@example.com"})
    assert reply["ok"] and reply["data"]["after"] == {"x": 2}
    assert log[-1][0] == "POST" and json.loads(log[-1][3])["approval_id"] == "a1"

    ext.execute("post_invoice", {"approval_id": "a2", "ref": "inv-1", "approved_by": "acc@example.com"})
    assert log[-1][1].endswith("/invoices/inv-1/post")
    assert json.loads(log[-1][3]) == {"approval_id": "a2", "approved_by": "acc@example.com"}


def test_long_ref_lists_are_chunked_and_merged():
    log = []
    refs = [f"r{i}" for i in range(REF_CHUNK * 2 + 5)]
    reply = client(log).execute("get_documents", {"type": "sale", "refs": refs})
    assert [i["ref"] for i in reply["data"]["items"]] == refs
    assert len(log) == 3


def test_errors_pass_through_with_status():
    reply = client([]).execute("apply_fix", {"approval_id": "a1", "closed": True})
    assert reply == {"ok": False, "status": 409, "error": {"error": "closed_period", "message": "Period is closed", "details": {}}}
    assert client([]).execute("nope", {})["status"] == 400


def test_unreachable_extension_reports_503():
    def boom(request):
        raise httpx.ConnectError("refused")

    ext = ExtensionClient("http://127.0.0.1:1/x", "t", transport=httpx.MockTransport(boom))
    reply = ext.execute("ping", {})
    assert reply["status"] == 503 and reply["error"]["error"] == "extension_unreachable"


def test_config_requires_loopback_extension(tmp_path):
    ini = tmp_path / "agent.ini"
    ini.write_text(
        "[agent]\nbackend_url = wss://app.example.uz/agent\n\n"
        "[base:A]\nagent_token = agt_a\nextension_url = http://127.0.0.1:8080/A/hs/aiapi/v1\nextension_token = x\n\n"
        "[base:B]\nagent_token = agt_b\nextension_url = http://localhost:8080/B/hs/aiapi/v1\nextension_token = y\n",
        encoding="utf-8",
    )
    configs = load_configs(ini)
    assert [c.name for c in configs] == ["A", "B"]
    assert configs[1].backend_url == "wss://app.example.uz/agent"

    bad = AgentConfig("x", "wss://a/agent", "t", "http://192.168.1.10:8080/A", "x")
    with pytest.raises(ValueError):
        bad.validate()
    with pytest.raises(ValueError):
        AgentConfig("x", "ws://example.com/agent", "t", "http://127.0.0.1/A", "x").validate()


def test_websocket_session_heartbeat_commands_and_reconnect(monkeypatch):
    monkeypatch.setattr(conn_module, "BACKOFF_START", 0.05)

    async def scenario():
        seen = {"connections": 0, "heartbeats": 0, "results": [], "auth": []}

        async def backend(ws):
            seen["auth"].append(ws.request.headers.get("Authorization"))
            seen["connections"] += 1
            hello = json.loads(await ws.recv())
            assert hello["type"] == "hello"
            await ws.send(json.dumps({"type": "command", "id": f"c{seen['connections']}", "command": "ping", "params": {}}))
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "heartbeat":
                    seen["heartbeats"] += 1
                elif msg["type"] == "result":
                    seen["results"].append(msg)
                    if seen["connections"] == 1:
                        await ws.close()  # simulate the Wi-Fi dropping
                        return

        async with serve(backend, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            cfg = AgentConfig("TEST", f"ws://127.0.0.1:{port}/agent", "agt_token", "http://127.0.0.1/TEST/hs/aiapi/v1", "ext-token", heartbeat_seconds=1)
            agent = AgentConnection(cfg, client([]))
            task = asyncio.create_task(agent.run_forever())
            for _ in range(100):
                if len(seen["results"]) >= 2:
                    break
                await asyncio.sleep(0.05)
            agent.stop()
            await asyncio.wait_for(task, 5)
        return seen

    seen = asyncio.run(scenario())
    assert seen["connections"] == 2  # reconnected after the drop
    assert [r["id"] for r in seen["results"]] == ["c1", "c2"]
    assert seen["results"][0]["reply"]["ok"] is True
    assert seen["heartbeats"] >= 2
    assert seen["auth"] == ["Bearer agt_token", "Bearer agt_token"]
