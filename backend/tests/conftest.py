"""Test setup: a throwaway PostgreSQL database, an in-process agent gateway and API helpers.

Needs a local PostgreSQL (TEST_DATABASE_ADMIN_URL, default postgres@127.0.0.1) and, for the
WebSocket test only, Redis.
"""

import os

os.environ.setdefault("JOBS_EAGER", "1")
os.environ.setdefault("SECRET_KEY", "test-secret-key-that-is-long-enough-for-hs256")
os.environ.setdefault("ANTHROPIC_API_KEY", "")

ADMIN_URL = os.environ.get("TEST_DATABASE_ADMIN_URL", "postgresql+psycopg://postgres@127.0.0.1:5432/postgres")
TEST_DB = "app_test"
os.environ["DATABASE_URL"] = ADMIN_URL.rsplit("/", 1)[0] + f"/{TEST_DB}"
os.environ.setdefault("READONLY_DATABASE_URL", ADMIN_URL.rsplit("/", 1)[0].replace("postgres@", "app_ro:app_ro@") + f"/{TEST_DB}")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

from app import models  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db import Base, set_engine, session_factory  # noqa: E402
from app.security import hash_password  # noqa: E402
from app.services import agent_gateway  # noqa: E402
from tests.fake_1c import TODAY, clean_base  # noqa: E402

get_settings.cache_clear()


@pytest.fixture(scope="session")
def engine():
    admin = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)"))
        conn.execute(text(f"CREATE DATABASE {TEST_DB}"))
        if not conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = 'app_ro'")).scalar():
            conn.execute(text("CREATE ROLE app_ro LOGIN PASSWORD 'app_ro'"))
    eng = create_engine(os.environ["DATABASE_URL"])
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("GRANT USAGE ON SCHEMA public TO app_ro"))
        conn.execute(text("GRANT SELECT ON companies, counterparties, items, documents, ledger_entries, invoices, audit_findings TO app_ro"))
    set_engine(eng)
    yield eng
    eng.dispose()


@pytest.fixture(autouse=True)
def clean_tables(engine):
    from app.services.onec import forget_verification

    forget_verification()
    yield
    with engine.begin() as conn:
        names = ", ".join(t.name for t in Base.metadata.sorted_tables)
        conn.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))


@pytest.fixture
def db(engine):
    session = session_factory()()
    yield session
    session.close()


class Harness:
    """One company backed by a FakeOneC, plus an in-process gateway that runs callbacks inline."""

    def __init__(self, db, fake):
        from app.jobs import command_callback

        self.db = db
        self.fakes = {}
        self.gateway = agent_gateway.LocalAgentGateway(self._handle, on_callback=command_callback)
        agent_gateway.set_gateway(self.gateway)
        self.company = self.add_company("TEST_CRYSTAL", fake)

    def _handle(self, company_id, command, params):
        return self.fakes[company_id](company_id, command, params)

    def add_company(self, name, fake):
        company = models.Company(name=name, inn=fake.inn)
        self.db.add(company)
        self.db.commit()
        self.fakes[company.id] = fake
        return company

    @property
    def fake(self):
        return self.fakes[self.company.id]

    def fetch(self, company_id=None):
        cid = company_id or self.company.id
        return lambda command, params: self.gateway.call(cid, command, params)

    def full_sync(self, company=None):
        from app.services.sync import full_sync

        company = company or self.company
        return full_sync(self.db, company, self.fetch(company.id), today=TODAY)

    def audit(self, company=None, **kw):
        from app.services.audit.engine import run_audit

        ids = run_audit(self.db, company or self.company, today=TODAY, **kw)
        self.db.commit()
        return ids


@pytest.fixture
def harness(db):
    h = Harness(db, clean_base())
    yield h
    agent_gateway.set_gateway(None)


@pytest.fixture
def make_harness(db):
    created = []

    def factory(plant=None):
        h = Harness(db, clean_base(plant))
        created.append(h)
        return h

    yield factory
    agent_gateway.set_gateway(None)


@pytest.fixture
def client(engine):
    from app.main import create_app

    return TestClient(create_app())


def make_user(db, email, role, company_ids=(), password="correct horse battery"):
    user = models.User(email=email, password_hash=hash_password(password), role=role, name=email.split("@")[0])
    db.add(user)
    db.flush()
    for cid in company_ids:
        db.add(models.UserCompany(user_id=user.id, company_id=cid))
    db.commit()
    return user


def login(client, email, password="correct horse battery"):
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}
