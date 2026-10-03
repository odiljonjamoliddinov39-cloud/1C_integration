"""How the backend talks to the agent on the laptop.

Commands go through Redis so that any process (API, RQ worker) can send them while only the API
process holds the agent's WebSocket:

    agent:queue:{company_id}   list of pending command envelopes. Writes wait here while the
                               laptop is offline and are delivered when the agent reconnects.
    agent:result:{command_id}  the agent's reply, for callers that wait for it (reads).
    agent:online:{company_id}  set with a TTL on every heartbeat.

A command envelope is {"id", "command", "params", "callback", "context"}. When `callback` is set,
the reply is also handed to `app.jobs.command_callback`, which updates the database (for example a
fix's before/after values) even if nobody is waiting anymore.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any, Protocol

from app.config import get_settings


class AgentOffline(Exception):
    """The laptop is not connected; reads should fall back to the mirror."""


class AgentTimeout(Exception):
    pass


class AgentCommandError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None, status: int = 500):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details or {}
        self.status = status


READ_COMMANDS = {
    "ping",
    "get_catalog",
    "get_documents",
    "get_ledger",
    "get_balances",
    "get_changes",
    "get_fix",
    # Generic access to any object of the base (see services/onec.py).
    "get_metadata",
    "list_objects",
    "get_object",
    "run_query",
}
WRITE_COMMANDS = {"create_invoice", "post_invoice", "apply_fix", "write_object"}


def make_envelope(command: str, params: dict, callback: str | None = None, context: dict | None = None):
    if command not in READ_COMMANDS | WRITE_COMMANDS:
        raise ValueError(f"Unknown agent command {command}")
    return {
        "id": str(uuid.uuid4()),
        "command": command,
        "params": params,
        "callback": callback,
        "context": context or {},
    }


def unwrap(reply: dict) -> Any:
    """Agent replies are {"ok": true, "data": ...} or {"ok": false, "error": {...}, "status": 409}."""
    if reply.get("ok"):
        return reply.get("data")
    err = reply.get("error") or {}
    raise AgentCommandError(
        err.get("error", "agent_error"),
        err.get("message", "Agent command failed"),
        err.get("details"),
        reply.get("status", 500),
    )


class AgentGateway(Protocol):
    def is_online(self, company_id: int) -> bool: ...

    def call(self, company_id: int, command: str, params: dict, timeout: int | None = None) -> Any:
        """Send a read command and wait for its data. Raises AgentOffline / AgentTimeout."""

    def enqueue(
        self, company_id: int, command: str, params: dict, callback: str, context: dict
    ) -> str:
        """Queue a write command. It runs now if the agent is online, else after reconnect."""


def queue_key(company_id: int) -> str:
    return f"agent:queue:{company_id}"


def processing_key(company_id: int) -> str:
    return f"agent:processing:{company_id}"


def result_key(command_id: str) -> str:
    return f"agent:result:{command_id}"


def online_key(company_id: int) -> str:
    return f"agent:online:{company_id}"


class RedisAgentGateway:
    def __init__(self, redis_client):
        self.redis = redis_client

    def is_online(self, company_id: int) -> bool:
        return bool(self.redis.exists(online_key(company_id)))

    def call(self, company_id: int, command: str, params: dict, timeout: int | None = None) -> Any:
        if not self.is_online(company_id):
            raise AgentOffline(f"Agent for company {company_id} is offline")
        envelope = make_envelope(command, params)
        self.redis.rpush(queue_key(company_id), json.dumps(envelope))
        timeout = timeout or get_settings().agent_command_timeout
        item = self.redis.blpop([result_key(envelope["id"])], timeout=timeout)
        if item is None:
            # Remove it if still queued so a stale read never runs later.
            self.redis.lrem(queue_key(company_id), 1, json.dumps(envelope))
            raise AgentTimeout(f"{command} timed out after {timeout}s")
        return unwrap(json.loads(item[1]))

    def enqueue(self, company_id: int, command: str, params: dict, callback: str, context: dict) -> str:
        envelope = make_envelope(command, params, callback, context)
        self.redis.rpush(queue_key(company_id), json.dumps(envelope))
        return envelope["id"]

    def pending(self, company_id: int) -> int:
        return int(self.redis.llen(queue_key(company_id)))


class LocalAgentGateway:
    """In-process gateway: runs commands through `handler` immediately. Used by tests and demos.

    `handler(company_id, command, params) -> reply dict` plays the part of agent + 1C extension.
    Set `online[company_id] = False` to simulate the laptop being offline: writes then queue up
    and run on `reconnect()`.
    """

    def __init__(self, handler: Callable[[int, str, dict], dict], on_callback=None):
        self.handler = handler
        self.on_callback = on_callback
        self.online: dict[int, bool] = {}
        self.queued: dict[int, list[dict]] = {}

    def is_online(self, company_id: int) -> bool:
        return self.online.get(company_id, True)

    def call(self, company_id: int, command: str, params: dict, timeout: int | None = None) -> Any:
        if not self.is_online(company_id):
            raise AgentOffline(f"Agent for company {company_id} is offline")
        return unwrap(self.handler(company_id, command, params))

    def enqueue(self, company_id: int, command: str, params: dict, callback: str, context: dict) -> str:
        envelope = make_envelope(command, params, callback, context)
        if self.is_online(company_id):
            self._run(company_id, envelope)
        else:
            self.queued.setdefault(company_id, []).append(envelope)
        return envelope["id"]

    def reconnect(self, company_id: int) -> None:
        self.online[company_id] = True
        for envelope in self.queued.pop(company_id, []):
            self._run(company_id, envelope)

    def _run(self, company_id: int, envelope: dict) -> None:
        reply = self.handler(company_id, envelope["command"], envelope["params"])
        if self.on_callback:
            self.on_callback(company_id, envelope, reply)


_gateway: AgentGateway | None = None


def get_gateway() -> AgentGateway:
    global _gateway
    if _gateway is None:
        from app.redis_conn import get_redis
        from app.services.connections import RoutingGateway

        # Companies connected directly (OData) bypass the agent; see services/connections.py.
        _gateway = RoutingGateway(RedisAgentGateway(get_redis()))
    return _gateway


def set_gateway(gateway: AgentGateway | None) -> None:
    global _gateway
    _gateway = gateway
