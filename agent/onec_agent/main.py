"""Command line: `onec-agent run` (foreground), `onec-agent check` (ping the extension).

On Windows the same executable is installed as a service, see onec_agent/service.py.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import logging.handlers
import sys

from onec_agent.config import load_configs
from onec_agent.connection import AgentConnection
from onec_agent.extension import ExtensionClient


def setup_logging(log_file: str = "") -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_file:
        handlers.append(logging.handlers.RotatingFileHandler(log_file, maxBytes=5_000_000, backupCount=5, encoding="utf-8"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)


class Agent:
    """All connections of this laptop (one per 1C base), run concurrently."""

    def __init__(self, configs):
        self.connections = [
            AgentConnection(c, ExtensionClient(c.extension_url, c.extension_token, c.request_timeout)) for c in configs
        ]

    async def run_forever(self) -> None:
        await asyncio.gather(*(c.run_forever() for c in self.connections))

    def stop(self) -> None:
        for c in self.connections:
            c.stop()


def build(configs=None) -> Agent:
    configs = configs or load_configs()
    setup_logging(configs[0].log_file)
    return Agent(configs)


def check() -> int:
    """Ping every configured base's extension and print the result."""
    failed = 0
    for config in load_configs():
        reply = ExtensionClient(config.extension_url, config.extension_token, 30).execute("ping", {})
        print(f"[{config.name}]", json.dumps(reply, ensure_ascii=False, indent=2))
        failed += not reply.get("ok")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="onec-agent")
    parser.add_argument("action", choices=["run", "check"], nargs="?", default="run")
    args = parser.parse_args(argv)
    if args.action == "check":
        return check()
    agent = build()
    try:
        asyncio.run(agent.run_forever())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
