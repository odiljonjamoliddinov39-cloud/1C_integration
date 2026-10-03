"""Which transport reaches each company's 1C base.

* `agent`: the Windows agent and the AIAPI extension (outbound WebSocket, see agent_gateway).
* `odata`: a direct HTTP connection to the base's standard OData interface (see odata.py). The
  address and 1C login are typed in Admin -> Companies -> Connect 1C.

`RoutingGateway` has the same interface as the agent gateways, so every caller (sync, fixes,
invoices, the direct object API) works with both transports.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from sqlalchemy import delete, select

from app.db import session_factory
from app.models import Company, OneCConnection, OneCSnapshot
from app.security import decrypt_secret
from app.services.agent_gateway import AgentGateway, AgentOffline, make_envelope, unwrap
from app.services.odata import ODataOneC, publication_name

KEEP_SNAPSHOTS = 3


class DbSnapshots:
    """DataVersion snapshots in PostgreSQL, so every API and worker process sees the same ones."""

    def __init__(self, company_id: int):
        self.company_id = company_id

    def save(self, cursor: str, versions: dict) -> None:
        with session_factory()() as db:
            db.add(OneCSnapshot(company_id=self.company_id, cursor=cursor, versions=versions))
            db.flush()
            keep = list(
                db.scalars(
                    select(OneCSnapshot.id)
                    .where(OneCSnapshot.company_id == self.company_id)
                    .order_by(OneCSnapshot.id.desc())
                    .limit(KEEP_SNAPSHOTS)
                )
            )
            db.execute(delete(OneCSnapshot).where(OneCSnapshot.company_id == self.company_id, OneCSnapshot.id.not_in(keep)))
            db.commit()

    def load(self, cursor: str) -> dict | None:
        with session_factory()() as db:
            return db.scalar(
                select(OneCSnapshot.versions).where(OneCSnapshot.company_id == self.company_id, OneCSnapshot.cursor == cursor)
            )


def base_path_for(url: str) -> str:
    """'http://10.0.0.5/TEST_CRYSTAL/odata/standard.odata/' -> 'http://10.0.0.5/TEST_CRYSTAL'.

    Stored as the company's base_path: its last part is what the right-base guard compares.
    """
    return url.split("/odata/")[0]


class RoutingGateway:
    def __init__(self, agent: AgentGateway, transport_factory: Callable[[int], httpx.BaseTransport | None] | None = None):
        self.agent = agent
        self.transport_factory = transport_factory
        self._connectors: dict[int, tuple[tuple, ODataOneC]] = {}

    # --- which transport -----------------------------------------------------------------------

    def connector(self, company_id: int) -> ODataOneC | None:
        """The direct connection for a company, or None when it uses the agent."""
        with session_factory()() as db:
            company = db.get(Company, company_id)
            if company is None or company.connection_type != "odata":
                return None
            conn = db.get(OneCConnection, company_id)
            if conn is None:
                return None
            key = (conn.url, conn.username, conn.password_enc)
        cached = self._connectors.get(company_id)
        if cached and cached[0] == key:
            return cached[1]
        if cached:
            cached[1].close()
        transport = self.transport_factory(company_id) if self.transport_factory else None
        connector = ODataOneC(key[0], key[1], decrypt_secret(key[2]), transport=transport, snapshots=DbSnapshots(company_id))
        self._connectors[company_id] = (key, connector)
        return connector

    def forget(self, company_id: int) -> None:
        cached = self._connectors.pop(company_id, None)
        if cached:
            cached[1].close()

    # --- gateway interface ---------------------------------------------------------------------

    def is_online(self, company_id: int) -> bool:
        with session_factory()() as db:
            company = db.get(Company, company_id)
            if company is not None and company.connection_type == "odata":
                conn = db.get(OneCConnection, company_id)
                return conn is not None and conn.last_error is None
        return self.agent.is_online(company_id)

    def pending(self, company_id: int) -> int | None:
        pending = getattr(self.agent, "pending", None)
        if pending is None or self.connector(company_id) is not None:
            return None
        return pending(company_id)

    def call(self, company_id: int, command: str, params: dict, timeout: int | None = None) -> Any:
        if self.connector(company_id) is None:
            return self.agent.call(company_id, command, params, timeout)
        reply = self.execute_direct(company_id, command, params)
        if not reply.get("ok") and reply.get("status") == 503:
            raise AgentOffline(reply["error"]["message"])
        return unwrap(reply)

    def enqueue(self, company_id: int, command: str, params: dict, callback: str, context: dict) -> str:
        if self.connector(company_id) is None:
            return self.agent.enqueue(company_id, command, params, callback, context)
        from app.jobs import enqueue, run_direct_command

        envelope = make_envelope(command, params, callback, context)
        enqueue(run_direct_command, company_id, envelope)
        return envelope["id"]

    def execute_direct(self, company_id: int, command: str, params: dict) -> dict:
        connector = self.connector(company_id)
        if connector is None:
            return {"ok": False, "status": 409, "error": {"error": "not_direct", "message": "Company uses the agent", "details": {}}}
        reply = connector.execute(command, params)
        _record_status(company_id, reply)
        return reply


def _record_status(company_id: int, reply: dict) -> None:
    """Remember whether 1C answered (shown as online/offline in the header)."""
    unreachable = not reply.get("ok") and reply.get("status") in (401, 503)
    now = datetime.now(timezone.utc)
    with session_factory()() as db:
        conn = db.get(OneCConnection, company_id)
        if conn is None:
            return
        if unreachable:
            message = reply["error"]["message"]
            if conn.last_error == message:
                return
            conn.last_error = message
        elif conn.last_error is None and conn.last_ok_at and now - conn.last_ok_at < timedelta(minutes=1):
            return
        else:
            conn.last_error = None
            conn.last_ok_at = now
        db.commit()


def describe(company: Company, conn: OneCConnection | None) -> dict | None:
    if company.connection_type != "odata" or conn is None:
        return None
    return {
        "url": conn.url,
        "address": base_path_for(conn.url),
        "base": publication_name(conn.url),
        "username": conn.username,
        "last_ok_at": conn.last_ok_at.isoformat() if conn.last_ok_at else None,
        "last_error": conn.last_error,
    }
