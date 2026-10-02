"""WebSocket endpoint the laptop agent connects to (outbound from the laptop, so no ports open there).

Protocol (JSON text frames):
    agent -> backend  {"type": "hello", "version": "1.0.0"}
                      {"type": "heartbeat"}                         every 30 s
                      {"type": "result", "id": "<command id>", "reply": {"ok": true, "data": ...}}
    backend -> agent  {"type": "command", "id": "...", "command": "get_documents", "params": {...}}
                      {"type": "heartbeat_ack"}

Commands are pulled from `agent:queue:{company_id}` (see services/agent_gateway.py) and moved to
`agent:processing:{company_id}` until the agent answers. After a dropped connection the unanswered
ones are delivered again; writes are safe to repeat because 1C applies each approval_id only once.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

import redis.asyncio as aioredis
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select

from app.config import get_settings
from app.db import session_factory
from app.models import Agent, Company, log_event
from app.security import hash_token
from app.services.agent_gateway import online_key, processing_key, queue_key, result_key

router = APIRouter()
log = logging.getLogger(__name__)


def _authenticate(token: str, version: str) -> int | None:
    db = session_factory()()
    try:
        agent = db.scalar(select(Agent).where(Agent.token_hash == hash_token(token), Agent.revoked.is_(False)))
        if agent is None:
            return None
        agent.last_seen = datetime.now(timezone.utc)
        agent.version = version or agent.version
        company = db.get(Company, agent.company_id)
        company.agent_id = agent.id
        log_event(db, "agent.connected", company_id=agent.company_id, version=version)
        db.commit()
        return agent.company_id
    finally:
        db.close()


def _touch(token: str) -> bool:
    """Record the heartbeat; False when the token was revoked meanwhile (the socket is then closed)."""
    db = session_factory()()
    try:
        agent = db.scalar(select(Agent).where(Agent.token_hash == hash_token(token)))
        if agent is None or agent.revoked:
            return False
        agent.last_seen = datetime.now(timezone.utc)
        db.commit()
        return True
    finally:
        db.close()


def _dispatch_callback(company_id: int, envelope: dict, reply: dict) -> None:
    from app.jobs import command_callback, enqueue

    enqueue(command_callback, company_id, envelope, reply)


@router.websocket("/agent")
async def agent_socket(ws: WebSocket):
    settings = get_settings()
    header = ws.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    company_id = await run_in_threadpool(_authenticate, token, ws.headers.get("x-agent-version", ""))
    if company_id is None:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await ws.accept()

    # BLMOVE below blocks for up to 5 s; keep the socket timeout well above that.
    r = aioredis.from_url(settings.redis_url, decode_responses=True, socket_timeout=30)
    ttl = settings.agent_heartbeat_seconds * 3
    await r.set(online_key(company_id), "1", ex=ttl)
    # Re-deliver commands left unanswered by a previous connection.
    while await r.lmove(processing_key(company_id), queue_key(company_id), "RIGHT", "LEFT"):
        pass

    in_flight: dict[str, dict] = {}
    # Callbacks run in the background: they may send further commands (re-sync after a fix)
    # whose replies this receiver must stay free to route.
    callbacks: set[asyncio.Task] = set()

    async def sender():
        while True:
            raw = await r.blmove(queue_key(company_id), processing_key(company_id), 5, "LEFT", "RIGHT")
            if raw is None:
                continue
            envelope = json.loads(raw)
            in_flight[envelope["id"]] = {"envelope": envelope, "raw": raw}
            await ws.send_text(
                json.dumps(
                    {"type": "command", "id": envelope["id"], "command": envelope["command"], "params": envelope["params"]}
                )
            )

    async def receiver():
        while True:
            message = json.loads(await ws.receive_text())
            kind = message.get("type")
            if kind == "heartbeat":
                if not await run_in_threadpool(_touch, token):
                    await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                    return
                await r.set(online_key(company_id), "1", ex=ttl)
                await ws.send_text(json.dumps({"type": "heartbeat_ack"}))
            elif kind == "hello":
                await r.set(online_key(company_id), "1", ex=ttl)
            elif kind == "result":
                entry = in_flight.pop(message.get("id"), None)
                if entry is None:
                    continue
                reply = message.get("reply") or {"ok": False, "error": {"error": "bad_reply", "message": "empty"}}
                await r.lrem(processing_key(company_id), 1, entry["raw"])
                await r.rpush(result_key(message["id"]), json.dumps(reply))
                await r.expire(result_key(message["id"]), 600)
                if entry["envelope"].get("callback"):
                    task = asyncio.create_task(run_in_threadpool(_dispatch_callback, company_id, entry["envelope"], reply))
                    callbacks.add(task)
                    task.add_done_callback(callbacks.discard)

    tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            exc = None if t.cancelled() else t.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                log.warning("agent socket for company %s closed: %r", company_id, exc)
    finally:
        for t in tasks:
            t.cancel()
        await r.delete(online_key(company_id))
        await r.aclose()
