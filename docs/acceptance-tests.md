# Acceptance tests

v1 is done when every test below passes on all 4 test copies of the bases. Only then is a live
base connected.

Each row says what is automated in this repo, and what must still be run by hand on the real
bases (the automated tests use an in-memory fake of 1C that follows `docs/api-contract.md`).

| Fn | Test | Pass condition | Automated | On the real test copies |
|---|---|---|---|---|
| E | Turn off the laptop's Wi-Fi for 10 minutes, then back on | Dashboard shows "last synced"; queued actions run after reconnect | `backend/tests/test_fixes.py::test_writes_wait_in_queue_while_agent_offline`, `test_agent_socket.py` (queued write delivered first on connect), `agent/tests/test_agent.py::test_websocket_session_heartbeat_commands_and_reconnect` | Approve a fix with Wi-Fi off; turn it on; fix shows **applied** |
| E | Log in as a Viewer assigned to one company | Sees only that company; Approve/Create hidden; API returns 403 | `backend/tests/test_auth_roles.py::test_viewer_sees_only_assigned_company_and_cannot_write` | Log in as the brother's account |
| E | Edit a document in 1C | Change appears in the app within 5 minutes | `backend/tests/test_sync.py::test_incremental_sync_picks_up_edits_and_new_documents` | Edit + re-post a document in TEST_CRYSTAL, wait ≤ 5 min |
| B | Compare cash, receivables, and OCB with 1C's own reports for one month | Every figure matches to the sum | `backend/tests/test_analytics.py::test_figures_match_the_books` | Compare with 1C ОСВ and Анализ счёта 5010 / 4010 for one month |
| B | Ask AI: "Why is Касса negative?" | Answer cites the days and documents behind it | `backend/tests/test_ai.py::test_ask_flow_with_mocked_claude` (flow, scoping, anonymization; Claude mocked) | Needs `ANTHROPIC_API_KEY`; ask on a copy with a negative cash day |
| D | Plant one error for each of the 12 rules in a test copy | Each produces exactly one finding with an explanation | `backend/tests/test_rules.py::test_planted_error_gives_exactly_one_finding` (12 cases) + `test_clean_base_has_no_findings` | Plant the 12 errors in a copy; explanations need the API key |
| C | Approve a VAT-RATE fix, then undo it | 1C shows the change, then the original values; both logged | `backend/tests/test_fixes.py::test_vat_rate_fix_then_undo` | Check the document in 1C and `ЖурналИзмененийAI` after each step |
| C | Try a fix dated in a closed period | Refused with 409; nothing changes in 1C | `backend/tests/test_fixes.py::test_fix_in_closed_period_is_refused_and_nothing_changes` | Set the prohibition date, approve a fix on an older document |
| A | Create, post, and "send" 3 invoices, one by Excel upload | Numbers, totals, and VAT match in 1C; statuses correct | `backend/tests/test_invoices.py` (form, copy, Excel, 3 invoices) | Check the 3 Счета-фактуры in 1C |
| A | Submit an invoice with an invalid INN | Blocked before it reaches 1C | `backend/tests/test_invoices.py::test_invalid_inn_is_blocked_before_1c` | — |
| AI | Ask a question about all 4 companies from Claude.ai via the MCP connector | Correct answer; a Viewer token cannot reach write tools | `backend/tests/test_mcp.py` | Add the connector in Claude Desktop / Claude.ai with an owner token, then a viewer token |
| Security | Call the extension from another PC on the network | Connection refused | Agent refuses non-loopback `extension_url` (`agent/tests`) | `curl http://<laptop-ip>:8080/...` from another PC → refused |

## Running the automated tests

```bash
# backend: needs PostgreSQL 16 (and Redis for test_agent_socket.py)
cd backend && pip install -r requirements-dev.txt && pytest

# agent
cd agent && pip install -r requirements-dev.txt && pytest

# web
cd web && npm ci && npm run build
```

`TEST_DATABASE_ADMIN_URL` (default `postgresql+psycopg://postgres@127.0.0.1:5432/postgres`)
points the backend tests at a server where they may create the `app_test` database.

## End-to-end run without 1C

`backend/scripts/fake_extension.py` serves the fake 1C over HTTP exactly like the extension, so
the real agent, backend and web app can run together on one machine (see the root README).
