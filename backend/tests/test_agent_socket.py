"""End-to-end over the real WebSocket + Redis: backend sends a command, the 'agent' answers."""

import threading

import pytest
import redis

from app.config import get_settings
from app.models import Role
from app.services import agent_gateway
from tests.conftest import login, make_user

REDIS_URL = "redis://localhost:6379/15"


@pytest.fixture
def real_redis(monkeypatch):
    try:
        r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        r.ping()
    except redis.ConnectionError:
        pytest.skip("Redis not available")
    r.flushdb()
    monkeypatch.setenv("REDIS_URL", REDIS_URL)
    get_settings.cache_clear()
    gateway = agent_gateway.RedisAgentGateway(r)
    agent_gateway.set_gateway(gateway)
    yield gateway
    agent_gateway.set_gateway(None)
    r.flushdb()
    monkeypatch.delenv("REDIS_URL")
    get_settings.cache_clear()


def test_agent_round_trip_and_queued_write(client, db, real_redis):
    from app.models import Company

    company = Company(name="TEST_CRYSTAL")
    db.add(company)
    db.commit()
    make_user(db, "owner@example.com", Role.OWNER)
    token = client.post(f"/api/admin/companies/{company.id}/agents", headers=login(client, "owner@example.com")).json()["token"]

    # A write queued while the agent is offline waits in Redis.
    queued_id = real_redis.enqueue(company.id, "apply_fix", {"approval_id": "a1"}, callback="none", context={})
    assert real_redis.pending(company.id) == 1
    with pytest.raises(agent_gateway.AgentOffline):
        real_redis.call(company.id, "ping", {})

    with pytest.raises(Exception):
        with client.websocket_connect("/agent", headers={"Authorization": "Bearer wrong"}) as ws:
            ws.receive_text()

    with client.websocket_connect("/agent", headers={"Authorization": f"Bearer {token}", "X-Agent-Version": "1.0.0"}) as ws:
        ws.send_json({"type": "hello", "version": "1.0.0"})
        # The queued write is delivered first after (re)connecting.
        cmd = ws.receive_json()
        assert cmd["id"] == queued_id and cmd["command"] == "apply_fix"
        ws.send_json({"type": "result", "id": cmd["id"], "reply": {"ok": True, "data": {"before": {}, "after": {}}}})

        result = {}
        caller = threading.Thread(target=lambda: result.update(data=real_redis.call(company.id, "ping", {}, timeout=10)))
        caller.start()
        cmd = ws.receive_json()
        assert cmd["command"] == "ping"
        ws.send_json({"type": "result", "id": cmd["id"], "reply": {"ok": True, "data": {"base_name": "TEST_CRYSTAL"}}})
        caller.join(10)
        assert result["data"] == {"base_name": "TEST_CRYSTAL"}

        ws.send_json({"type": "heartbeat"})
        assert ws.receive_json() == {"type": "heartbeat_ack"}
        assert real_redis.is_online(company.id)
        assert real_redis.pending(company.id) == 0
