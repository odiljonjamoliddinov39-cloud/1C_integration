"""Create a fresh demo database: migrations, logins, the four companies and agent tokens.

    python -m scripts.demo_seed --admin-url postgresql+psycopg://postgres:postgres@127.0.0.1:5432/postgres \
        --db app_demo --agent-ini ../.demo/agent.ini --extension-url http://127.0.0.1:8081

Used by scripts/demo.sh at the repo root. Never point it at a real database: it drops `--db`.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from sqlalchemy import create_engine, text

COMPANIES = [
    ("CRYCTAL WATER TREDE MCHJ", "TEST_CRYSTAL"),
    ("TEXMASH IMPORT MCHJ", "TEST_TEXMASH"),
    ("OOO CRYCTAL WATER TREDE", "TEST_CRYSTAL_OOO"),
    ("Техмаш импорт", "TEST_TEHMASH"),
]
USERS = [
    ("owner@example.com", "Owner", "owner-password-1", "owner", None),
    ("accountant@example.com", "Accountant", "accountant-password-1", "accountant", [1, 2, 3, 4]),
    ("viewer@example.com", "Viewer", "viewer-password-1", "viewer", [2]),
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--admin-url", required=True)
    parser.add_argument("--db", default="app_demo")
    parser.add_argument("--agent-ini", required=True)
    parser.add_argument("--extension-url", default="http://127.0.0.1:8081")
    parser.add_argument("--extension-token", default="ext-token")
    parser.add_argument("--backend-ws", default="ws://127.0.0.1:8000/agent")
    args = parser.parse_args()

    if args.db in ("postgres", "app"):
        raise SystemExit("Refusing to drop a database named postgres/app; use a demo name")

    admin = create_engine(args.admin_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{args.db}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{args.db}"'))
        if not conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = 'app_ro'")).scalar():
            conn.execute(text("CREATE ROLE app_ro LOGIN PASSWORD 'app_ro'"))
    admin.dispose()

    db_url = args.admin_url.rsplit("/", 1)[0] + f"/{args.db}"
    os.environ["DATABASE_URL"] = db_url

    from alembic import command
    from alembic.config import Config

    from app.config import get_settings

    get_settings.cache_clear()
    command.upgrade(Config(str(Path(__file__).resolve().parent.parent / "alembic.ini")), "head")

    from app.db import session_factory
    from app.models import Agent, Company, User, UserCompany
    from app.security import hash_password, hash_token, new_token

    db = session_factory()()
    companies = [Company(name=name, base_path=f"C:/1C/Bases/{base}") for name, base in COMPANIES]
    db.add_all(companies)
    db.flush()
    for email, name, password, role, company_ids in USERS:
        user = User(email=email, name=name, password_hash=hash_password(password), role=role)
        db.add(user)
        db.flush()
        for cid in company_ids or []:
            db.add(UserCompany(user_id=user.id, company_id=cid))

    lines = ["[agent]", f"backend_url = {args.backend_ws}", "heartbeat_seconds = 30", ""]
    for company, (_, base) in zip(companies, COMPANIES):
        token = new_token("agt")
        db.add(Agent(company_id=company.id, token_hash=hash_token(token)))
        lines += [
            f"[base:{base}]",
            f"agent_token = {token}",
            f"extension_url = {args.extension_url}/{base}/hs/aiapi/v1",
            f"extension_token = {args.extension_token}",
            "",
        ]
    db.commit()
    db.close()

    Path(args.agent_ini).write_text("\n".join(lines), encoding="utf-8")
    print(f"demo database {args.db} ready; agent config written to {args.agent_ini}")


if __name__ == "__main__":
    main()
