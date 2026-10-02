"""The outbound WebSocket to the backend: hello, heartbeat every 30 s, commands, reconnect with backoff.

Commands run one at a time, in the order received, in a worker thread so the heartbeat keeps going
while 1C is busy. If the connection drops mid-command, the backend re-sends unanswered commands
after reconnect; 1C applies each approval_id only once, so repeating a write is safe.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from onec_agent.config import VERSION, AgentConfig
from onec_agent.extension import ExtensionClient

log = logging.getLogger("onec_agent")

BACKOFF_START = 1.0
BACKOFF_MAX = 60.0


def next_backoff(current: float) -> float:
    return min(BACKOFF_MAX, current * 2)


class AgentConnection:
    def __init__(self, config: AgentConfig, extension: ExtensionClient):
        self.config = config
        self.extension = extension
        self.stop_event = asyncio.Event()
        self.connected = False

    async def run_forever(self) -> None:
        backoff = BACKOFF_START
        while not self.stop_event.is_set():
            self.connected = False
            try:
                await self.run_once()
                backoff = BACKOFF_START
            except InvalidStatus as e:
                status = e.response.status_code
                log.error("[%s] backend refused the connection (HTTP %s); check agent_token", self.config.name, status)
                backoff = BACKOFF_MAX if status in (401, 403) else next_backoff(backoff)
            except (OSError, ConnectionClosed, asyncio.TimeoutError) as e:
                log.warning("[%s] connection lost: %r", self.config.name, e)
                # A drop after a good connection starts the backoff over; failed attempts grow it.
                backoff = BACKOFF_START if self.connected else next_backoff(backoff)
            if self.stop_event.is_set():
                break
            delay = backoff * (0.8 + 0.4 * random.random())
            log.info("reconnecting in %.0f s", delay)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

    async def run_once(self) -> None:
        headers = {"Authorization": f"Bearer {self.config.agent_token}", "X-Agent-Version": VERSION}
        async with connect(self.config.backend_url, additional_headers=headers, open_timeout=20, ping_interval=None) as ws:
            self.connected = True
            log.info("[%s] connected to %s", self.config.name, self.config.backend_url)
            await ws.send(json.dumps({"type": "hello", "version": VERSION}))
            queue: asyncio.Queue = asyncio.Queue()
            tasks = [
                asyncio.create_task(self._heartbeat(ws)),
                asyncio.create_task(self._receive(ws, queue)),
                asyncio.create_task(self._work(ws, queue)),
                asyncio.create_task(self.stop_event.wait()),
            ]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    if not task.cancelled() and task.exception():
                        raise task.exception()
            finally:
                for task in tasks:
                    task.cancel()

    async def _heartbeat(self, ws) -> None:
        while True:
            await ws.send(json.dumps({"type": "heartbeat"}))
            await asyncio.sleep(self.config.heartbeat_seconds)

    async def _receive(self, ws, queue: asyncio.Queue) -> None:
        async for raw in ws:
            message = json.loads(raw)
            if message.get("type") == "command":
                await queue.put(message)

    async def _work(self, ws, queue: asyncio.Queue) -> None:
        while True:
            message = await queue.get()
            command, params = message.get("command", ""), message.get("params") or {}
            log.info("[%s] command %s %s", self.config.name, command, message.get("id"))
            reply = await asyncio.to_thread(self.extension.execute, command, params)
            if not reply.get("ok"):
                log.warning("[%s] command %s failed: %s", self.config.name, command, reply.get("error"))
            await ws.send(json.dumps({"type": "result", "id": message["id"], "reply": reply}, ensure_ascii=False))

    def stop(self) -> None:
        self.stop_event.set()
