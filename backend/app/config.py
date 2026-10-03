"""Application settings, read from environment variables (and `.env` in dev).

Secrets never live in the repo: production values come from `deploy/.env` on the server.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Main connection (read/write) and the read-only one used by Ask AI.
    database_url: str = "postgresql+psycopg://app:app@localhost:5432/app"
    readonly_database_url: str = "postgresql+psycopg://app_ro:app_ro@localhost:5432/app"
    redis_url: str = "redis://localhost:6379/0"

    secret_key: str = "change-me"
    session_hours: int = 12
    cors_origins: list[str] = ["http://localhost:5173"]

    # Claude API. Leave the key empty to disable AI features (explanations fall back to text).
    anthropic_api_key: str = ""
    claude_model: str = "claude-opus-5-5"
    ai_anonymize_default: bool = False
    ask_ai_timeout_seconds: int = 10

    # How long a backend call waits for the agent before treating it as offline.
    agent_command_timeout: int = 60
    agent_heartbeat_seconds: int = 30
    incremental_sync_minutes: int = 5
    nightly_audit_hour: int = 2

    # Chart-of-accounts codes (НСБУ Узбекистана). Override if a base uses other sub-accounts.
    cash_account: str = "5010"
    bank_account: str = "5110"
    receivable_prefix: str = "40"
    payable_prefix: str = "60"
    vat_output_account: str = "6410"
    vat_input_account: str = "4410"
    inventory_prefixes: list[str] = ["10", "29"]
    settlement_prefixes: list[str] = ["40", "50", "51", "60"]

    einvoice_provider: str = "stub"

    # Direct (OData) connections: when the backend runs in Docker, "localhost" / "127.0.0.1" typed
    # in Connect 1C is rewritten to this host name (host.docker.internal), i.e. the computer itself.
    onec_localhost_alias: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
