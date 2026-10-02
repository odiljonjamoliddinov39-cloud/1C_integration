# 1C Full Integration App

A web app connected to **1C: Бухгалтерия для Узбекистана 3.0** that covers five functions:

| | Function | Where |
|---|---|---|
| A | Schet-faktura entry: form, Excel bulk entry, create and post in 1C, send to the e-invoice operator | `backend/app/services/invoices.py`, `web/src/pages/Invoices.tsx` |
| B | Analytics: cash/bank, receivables/payables, debt aging, sales/purchases, VAT, ОСВ, Ask AI | `backend/app/services/analytics.py`, `web/src/pages/Dashboard.tsx` |
| C | Error correction: propose, approve (`approval_id`), apply in 1C, re-check, undo | `backend/app/services/fixes.py`, `web/src/pages/Fixes.tsx` |
| D | Auto audit: 12 rules after every sync and nightly, Claude explanations, monthly PDF | `backend/app/services/audit/`, `web/src/pages/Findings.tsx` |
| E | Online work: outbound agent, offline mirror and queued writes, roles | `agent/`, `backend/app/routers/agent_ws.py` |

The pilot is for four companies, but every table carries `company_id`, so outsourcing clients
can be added later.

## Architecture

```
Laptop (no inbound ports)                    VPS (Docker Compose, HTTPS)
  1C bases ×4 + extension AIAPI                FastAPI · RQ worker · scheduler · MCP
  Apache on 127.0.0.1:8080                     PostgreSQL mirror · Redis · Caddy
        ▲                                                 ▲
        │ HTTP, 127.0.0.1 only                            │ HTTPS, checked by role
  Agent (Windows service) ── outbound WSS ──▶  /agent     Browser · Claude.ai/Desktop (MCP)
                                                          Claude API · e-invoice operator
```

Only the agent touches 1C. Every write needs an `approval_id` that the backend issues when a
person approves. In 1C each write runs in one transaction, is logged to `ЖурналИзмененийAI`, and
is refused for a closed period.

## Repo layout

```
extension/   1C extension: BSL sources, objects to create, Apache/vrd for 127.0.0.1
agent/       Windows agent (Python 3.12, PyInstaller, service + installer)
backend/     FastAPI app, SQLAlchemy models, Alembic migrations, audit rules, tests
web/         React + Vite + TypeScript + Tailwind + Recharts
deploy/      docker-compose.yml, Caddyfile, backups
docs/        API contract, acceptance tests, session checklist
```

## Quick demo (Codespaces or VS Code)

Runs everything with a fake 1C for the four companies, so no 1C or Windows is needed:

* **VS Code / Codespaces:** *Terminal → Run Task… → Run demo (fake 1C)*, or `bash scripts/demo.sh` in the terminal.
* Open port **5173** (in Codespaces: the **PORTS** tab → port 5173 → globe icon).
* Log in as `owner@example.com` / `owner-password-1` (also `accountant@example.com` / `accountant-password-1`
  and `viewer@example.com` / `viewer-password-1`, who sees TEXMASH only).

The script starts PostgreSQL and Redis in Docker (or reuses ones already on 5432/6379), installs the Python
and npm packages, creates a fresh `app_demo` database, and starts the backend, fake 1C, agent and web app.
It then runs a first sync. `Ctrl+C` stops everything, and the logs are in `.demo/`.

## Run locally

Requirements: Python 3.12, Node 22, PostgreSQL 16, Redis 7.

```bash
# backend
cd backend
python -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
cp .env.example .env                     # point DATABASE_URL at a local database
alembic upgrade head
python -m app.cli create-owner you@example.com
uvicorn app.main:app --reload            # http://localhost:8000/api/docs
rq worker default                        # in another terminal (or set JOBS_EAGER=1)

# web
cd web && npm ci && npm run dev          # http://localhost:5173 (proxies /api to :8000)
```

### Without 1C: the fake extension

```bash
cd backend && python -m scripts.fake_extension --port 8081 --token ext-token --bases TEST_CRYSTAL
```

In the web app, go to Admin → Companies → **Agent token**. Then write an `agent.ini` with
`backend_url = ws://127.0.0.1:8000/agent`,
`extension_url = http://127.0.0.1:8081/TEST_CRYSTAL/hs/aiapi/v1` and `extension_token = ext-token`,
and run `cd agent && ONEC_AGENT_CONFIG=agent.ini python -m onec_agent run`. Then click **Sync now**.

## Tests

```bash
cd backend && pytest     # 57 tests on PostgreSQL, including all 12 audit rules and the acceptance flows
cd agent && pytest
cd web && npm run build
```

See [`docs/acceptance-tests.md`](docs/acceptance-tests.md) for how each acceptance test is covered,
and [`docs/sessions.md`](docs/sessions.md) for what is left to do on the laptop and the VPS.

## Open questions from the spec

- **E-invoicing operator** (Didox, Faktura.uz or Soliq): the operator sits behind the
  `EinvoiceProvider` interface. v1 ships the stub, which marks invoices *ready to send*.
- **File or client-server bases**: file bases are assumed (`default.vrd` uses `File=`). For a SQL
  base, change `ib=` to `Srvr=…;Ref=…`.
