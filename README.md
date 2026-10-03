# 1C Full Integration App

A web app connected to **1C: Бухгалтерия для Узбекистана 3.0** that covers five functions:

| | Function | Where |
|---|---|---|
| A | Schet-faktura entry: form, Excel bulk entry, create and post in 1C, send to the e-invoice operator | `backend/app/services/invoices.py`, `web/src/pages/Invoices.tsx` |
| B | Analytics: cash/bank, receivables/payables, debt aging, sales/purchases, VAT, ОСВ, Ask AI | `backend/app/services/analytics.py`, `web/src/pages/Dashboard.tsx` |
| C | Error correction: propose, approve (`approval_id`), apply in 1C, re-check, undo | `backend/app/services/fixes.py`, `web/src/pages/Fixes.tsx` |
| D | Auto audit: 12 rules after every sync and nightly, Claude explanations, monthly PDF | `backend/app/services/audit/`, `web/src/pages/Findings.tsx` |
| E | Online work: outbound agent, offline mirror and queued writes, roles | `agent/`, `backend/app/routers/agent_ws.py` |

The web app speaks **Uzbek (Latin), Russian and English**, with a switcher in the header and on the login page.
Audit finding texts are written in Russian, like the 1C documents they describe.

The pilot is for four companies, but every table carries `company_id`, so outsourcing clients
can be added later.

## Connecting a 1C base: two ways

| | **Direct (recommended to start)** | **Agent + extension** |
|---|---|---|
| Set up in 1C | Publish the base with «Публиковать стандартный интерфейс OData» ticked, allow the objects in «Настройка стандартного интерфейса OData», create a 1C user | Build the AIAPI extension in the Configurator, publish it on Apache, install the agent service |
| Set up in the app | Admin → **Connect a 1C base**: address, base name, 1C user and password → *Test connection* → *Connect and sync* | Admin → Agent token → `agent.ini` on the laptop |
| Network | The app must reach the 1C web server (same LAN, or VPN) | None inbound: the agent connects out |
| 1C queries (`/query`) | Not available (OData filters only) | Available |
| Multi-object writes (merge counterparties) | Several calls | One 1C transaction |

Both feed the same mirror, audit, fixes, invoices and direct API, and both need approval for
every write. A company can switch between them at any time. See [`docs/direct-connection.md`](docs/direct-connection.md).

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

Besides the five functions there is a **direct 1C API** (`/api/onec/{company_id}/...`, and the same
calls as MCP tools). It reads anything in the company's base, such as the configuration's
metadata, any catalog, document, register, chart of accounts or enum, and runs 1C queries. It also
proposes changes to any catalog item or document: create, update, post, unpost, mark for deletion.
A proposed change is a normal fix: nothing reaches 1C until a person approves it, and it can be
undone. A **right-base guard** checks that the agent is connected to that company's base (INN and
base name) before any sync, read or write. See [`docs/api-contract.md`](docs/api-contract.md) §1 and §3.

Only the agent (or, for directly connected companies, the backend over OData) touches 1C. Every write needs an `approval_id` that the backend issues when a
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

## Testing on your own computer with your real 1C

Docker Desktop, then `powershell -ExecutionPolicy Bypass -File start-local.ps1` (or `./start-local.sh`)
→ http://localhost:8080 → Admin → **Connect a 1C base**. See [`docs/local-testing.md`](docs/local-testing.md).

## Quick demo (Codespaces or VS Code)

Runs everything with a fake 1C for the four companies, so no 1C or Windows is needed:

* **VS Code / Codespaces:** `npm run dev` in the terminal at the repo root (same as `bash scripts/demo.sh`), or *Terminal → Run Task… → Run demo (fake 1C)*.
* Open port **5173** (in Codespaces: the **PORTS** tab → port 5173 → globe icon).
* Log in as `owner@example.com` / `owner-password-1` (also `accountant@example.com` / `accountant-password-1`
  and `viewer@example.com` / `viewer-password-1`, who sees TEXMASH only).
* To try the direct connection: Admin → **Connect a 1C base** → address `127.0.0.1:8081`, base `TEST_DIRECT`,
  user `odata`, password `odata-password`.

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
cd backend && pytest     # 103 tests on PostgreSQL; sync, audit, fixes, invoices and the direct API run on both transports, including all 12 audit rules and the acceptance flows
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
