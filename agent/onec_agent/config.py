"""Agent configuration: `agent.ini` next to the executable (or the path in ONEC_AGENT_CONFIG).

One agent process serves every base on the laptop; each base has its own section, its own
agent token (one per company, revocable in the web app) and its own extension URL:

[agent]
backend_url = wss://app.example.uz/agent
heartbeat_seconds = 30
log_file = C:\\ProgramData\\OneCAgent\\agent.log

[base:TEST_CRYSTAL]
agent_token = agt_...
extension_url = http://127.0.0.1:8080/TEST_CRYSTAL/hs/aiapi/v1
extension_token = ...                      ; the token stored in the 1C extension (constant ТокенAIAPI)

With a single base, the base keys can also sit directly in [agent]. Environment variables
ONEC_AGENT_BACKEND_URL, ONEC_AGENT_TOKEN, ONEC_AGENT_EXTENSION_URL and ONEC_AGENT_EXTENSION_TOKEN
configure one base without a file.
"""

from __future__ import annotations

import configparser
import os
import sys
from dataclasses import dataclass
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlparse

VERSION = "1.0.0"


@dataclass
class AgentConfig:
    name: str
    backend_url: str
    agent_token: str
    extension_url: str
    extension_token: str
    heartbeat_seconds: int = 30
    request_timeout: int = 120
    log_file: str = ""

    def validate(self) -> None:
        if not self.backend_url.startswith(("wss://", "ws://")):
            raise ValueError("backend_url must start with wss://")
        if self.backend_url.startswith("ws://") and not _is_loopback(urlparse(self.backend_url).hostname):
            raise ValueError("Use wss:// for a remote backend")
        if not _is_loopback(urlparse(self.extension_url).hostname):
            # The extension must only ever be reached on this machine.
            raise ValueError("extension_url must point to 127.0.0.1 / localhost")
        if not self.agent_token or not self.extension_token:
            raise ValueError("agent_token and extension_token are required")


def _is_loopback(host: str | None) -> bool:
    if host in ("localhost",):
        return True
    try:
        return ip_address(host or "").is_loopback
    except ValueError:
        return False


def default_config_path() -> Path:
    if env := os.environ.get("ONEC_AGENT_CONFIG"):
        return Path(env)
    base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path.cwd()
    return base / "agent.ini"


def load_configs(path: Path | None = None) -> list[AgentConfig]:
    parser = configparser.ConfigParser()
    path = path or default_config_path()
    if path.exists():
        parser.read(path, encoding="utf-8")
    common = parser["agent"] if parser.has_section("agent") else {}

    def get(section, key: str, env: str | None = None, default: str = "") -> str:
        return (os.environ.get(env) if env else None) or section.get(key) or common.get(key, default)

    sections = [parser[s] for s in parser.sections() if s.startswith("base:")] or [common]
    configs = []
    for section in sections:
        cfg = AgentConfig(
            name=section.name.split(":", 1)[1] if hasattr(section, "name") and ":" in section.name else "default",
            backend_url=get(section, "backend_url", "ONEC_AGENT_BACKEND_URL"),
            agent_token=get(section, "agent_token", "ONEC_AGENT_TOKEN" if len(sections) == 1 else None),
            extension_url=get(section, "extension_url", "ONEC_AGENT_EXTENSION_URL" if len(sections) == 1 else None).rstrip("/"),
            extension_token=get(section, "extension_token", "ONEC_AGENT_EXTENSION_TOKEN" if len(sections) == 1 else None),
            heartbeat_seconds=int(get(section, "heartbeat_seconds", "ONEC_AGENT_HEARTBEAT", "30")),
            request_timeout=int(get(section, "request_timeout", "ONEC_AGENT_REQUEST_TIMEOUT", "120")),
            log_file=get(section, "log_file", "ONEC_AGENT_LOG_FILE"),
        )
        cfg.validate()
        configs.append(cfg)
    return configs
