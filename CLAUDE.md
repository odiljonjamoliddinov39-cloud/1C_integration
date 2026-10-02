# 1C Integration: notes for Claude Code

- Spec: `docs/spec.pdf`; extension/agent contract: `docs/api-contract.md`; status per session: `docs/sessions.md`.
- Backend tests need PostgreSQL 16 (`TEST_DATABASE_ADMIN_URL`) and Redis for `test_agent_socket.py`:
  `cd backend && pytest`. Agent: `cd agent && pytest`. Web: `cd web && npm run build`.
- `backend/tests/fake_1c.py` is the in-memory stand-in for 1C + the extension; keep it in step with
  `extension/src/` and `docs/api-contract.md` when the contract changes.
- Adding an audit rule: one `@rule` function in `backend/app/services/audit/rules/`, plant its error in
  `clean_base()` (`tests/fake_1c.py`) and add the code to `ALL_RULES` in `tests/test_rules.py`.
- Every write to 1C goes through an approval (`approval_id`); never add a path that writes without one.
- Every query must be filtered by the user's companies on the backend (`app/deps.py`).
- All 1C metadata names live in `extension/src/CommonModules/AIAPI_Метаданные.bsl`.
