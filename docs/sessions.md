# Task breakdown: status

The spec plans 53 hours in 13 sessions. All the **code** for every session is in this repo and
tested against a fake 1C. What is left is work that only happens on the laptop and the server:
installing software, checking 1C names against the real configuration, and running the
acceptance tests on the four test copies.

Legend: ✅ done in the repo · 🖥 to do on the laptop or VPS

## Session 1: Foundation
- ✅ Repo, `deploy/docker-compose.yml` with PostgreSQL, Redis, FastAPI (`/api/health`)
- 🖥 Make test copies of all 4 bases
- 🖥 Install Apache 2.4 + 1C web module; publish TEST_CRYSTAL on 127.0.0.1 only (`extension/apache/`)
- ✅ Extension skeleton: `aiapi` HTTP service, token check, `/ping` (`extension/src/`)
- 🖥 Create the extension objects in the Configurator (`extension/README.md`), check `/ping` in the browser

## Session 2: Read API
- ✅ `/catalogs/{name}` with `changed_since`, `/documents/{type}` with headers and rows, `/ledger`, `/balances`
- 🖥 Compare the names in `AIAPI_Метаданные` with TEST_CRYSTAL (lines marked `ПРОВЕРИТЬ`)

## Session 3: Agent and first sync
- ✅ SQLAlchemy models + Alembic migrations for all 12 tables (`backend/alembic/versions/`)
- ✅ Agent: WebSocket client, heartbeat, reconnect with backoff, command handler (`agent/`)
- ✅ Backend: `/agent` endpoint and full-sync job

## Session 4: Incremental sync, users, web shell
- ✅ `/changes?since=` (change-registration register + event subscriptions) and the 5-minute incremental sync (`app/scheduler.py`)
- ✅ Auth: login, Argon2, 12-hour sessions, TOTP for owners, roles, company access filter
- ✅ React app: login page, layout, company switcher

## Session 5: Analytics (B)
- ✅ Cash and bank widget, OCB table
- ✅ Receivables, payables (top 10), debt aging
- ✅ Sales and purchases by month, VAT widget
- ✅ Click-through to documents, Excel export

## Session 6: Auto audit (D)
- ✅ Rule engine + 12 rules, each with a test (`backend/app/services/audit/rules/`, `backend/tests/test_rules.py`)
- ✅ Findings page with filters and ignore (ignored findings stay hidden until their data changes)

## Session 7: AI layer
- ✅ Claude explanation for each finding, with a name-anonymization option
- ✅ Ask AI: question → validated read-only SQL (scoped to the user's companies, 10 s timeout) → explained answer
- ✅ Monthly audit report as PDF
- ✅ MCP endpoint `/mcp` (per-user token, read tools for all companies, write tools only through approvals)
- 🖥 Set `ANTHROPIC_API_KEY` on the server

## Session 8: Error correction (C), core
- ✅ 1C `/fixes`: one transaction, closed-period check (409), `ЖурналИзмененийAI`, approval idempotency
- ✅ Backend: proposal, approval, `approval_id`, apply, re-check
- ✅ UI: side-by-side before/after, Approve

## Session 9: Error correction (C), fix types
- ✅ The 5 fix types in 1C and the backend
- ✅ Undo (reverse fix from `before_json`) and bulk approve (≤ 50, same type, each logged)

## Session 10: Schet-faktura (A), core
- ✅ 1C `/invoices` and `/invoices/{id}/post`
- ✅ Invoice form: buyer search (name or INN), contract, items with autofill

## Session 11: Schet-faktura (A), complete
- ✅ Validation rules and copy-as-template
- ✅ Bulk entry from Excel with preview
- ✅ `EinvoiceProvider` interface and stub provider
- 🖥 Decide the operator (Didox / Faktura.uz / Soliq) and implement its provider

## Session 12: Deploy and connect all bases
- ✅ Docker Compose, Caddy (automatic HTTPS), daily backups kept 14 days (`deploy/`)
- ✅ Agent as a Windows service with an installer (`agent/installer/install.ps1`, `agent/agent.spec`)
- 🖥 VPS + domain; `docker compose up -d --build`; build `OneCAgent.exe` on Windows; publish and connect bases 2–4 (test copies)

## Session 13: Acceptance testing
- ✅ Automated versions of the acceptance tests (`docs/acceptance-tests.md`)
- 🖥 Run every test on all 4 test copies; fix what fails; then connect live bases
