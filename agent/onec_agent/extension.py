"""Calls the 1C extension's HTTP service (`/hs/aiapi/v1/...`) on 127.0.0.1, with the Bearer token.

Each backend command maps to one endpoint (docs/api-contract.md). Long `refs` lists are split
into chunks so URLs stay short, and the chunks' `items` are merged.
"""

from __future__ import annotations

from typing import Any

import httpx

REF_CHUNK = 50


class ExtensionClient:
    def __init__(self, base_url: str, token: str, timeout: int = 120, transport: httpx.BaseTransport | None = None):
        self.http = httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=timeout,
            transport=transport,
            trust_env=False,  # never route 127.0.0.1 traffic through a proxy
        )

    def close(self) -> None:
        self.http.close()

    # --- dispatch ------------------------------------------------------------------------------

    def execute(self, command: str, params: dict) -> dict:
        """Run one backend command; returns the reply envelope {"ok", "data" | "error", "status"}."""
        handler = getattr(self, f"cmd_{command}", None)
        if handler is None:
            return _error(400, "unknown_command", f"Agent does not support {command}")
        try:
            return {"ok": True, "data": handler(**params)}
        except ExtensionError as e:
            return {"ok": False, "status": e.status, "error": e.body}
        except httpx.TransportError as e:
            return _error(503, "extension_unreachable", f"1C web service is not reachable: {e}")
        except TypeError as e:
            return _error(400, "bad_params", str(e))

    # --- reads ---------------------------------------------------------------------------------

    def cmd_ping(self) -> Any:
        return self._get("/ping")

    def cmd_get_catalog(self, name: str, changed_since: str | None = None, refs: list[str] | None = None) -> Any:
        return self._get_chunked(f"/catalogs/{name}", {"changed_since": changed_since}, refs)

    def cmd_get_documents(self, type: str, refs: list[str] | None = None, **period) -> Any:
        return self._get_chunked(f"/documents/{type}", {"from": period.get("from"), "to": period.get("to")}, refs)

    def cmd_get_ledger(self, refs: list[str] | None = None, **period) -> Any:
        return self._get_chunked("/ledger", {"from": period.get("from"), "to": period.get("to")}, refs)

    def cmd_get_balances(self, date: str, account: str | None = None) -> Any:
        return self._get("/balances", {"date": date, "account": account})

    def cmd_get_changes(self, since: str | None = None) -> Any:
        return self._get("/changes", {"since": since})

    def cmd_get_fix(self, id: str) -> Any:
        return self._get(f"/fixes/{id}")

    # --- writes (each carries the backend's approval_id) ---------------------------------------

    def cmd_create_invoice(self, **payload) -> Any:
        return self._post("/invoices", payload)

    def cmd_post_invoice(self, approval_id: str, ref: str, **extra) -> Any:
        # extra: approved_by and any future fields, passed to 1C for ЖурналИзмененийAI.
        return self._post(f"/invoices/{ref}/post", {"approval_id": approval_id, **extra})

    def cmd_apply_fix(self, **payload) -> Any:
        return self._post("/fixes", payload)

    # --- http ----------------------------------------------------------------------------------

    def _get(self, path: str, params: dict | None = None) -> Any:
        clean = {k: v for k, v in (params or {}).items() if v not in (None, "")}
        return self._handle(self.http.get(path, params=clean))

    def _get_chunked(self, path: str, params: dict, refs: list[str] | None) -> Any:
        if not refs:
            return self._get(path, params)
        merged: dict | None = None
        for i in range(0, len(refs), REF_CHUNK):
            part = self._get(path, {**params, "refs": ",".join(refs[i : i + REF_CHUNK])})
            if merged is None:
                merged = part
            else:
                merged["items"].extend(part.get("items", []))
        return merged

    def _post(self, path: str, body: dict) -> Any:
        return self._handle(self.http.post(path, json=body))

    @staticmethod
    def _handle(response: httpx.Response) -> Any:
        if response.status_code >= 400:
            try:
                body = response.json()
            except ValueError:
                body = {"error": "http_error", "message": response.text[:500], "details": {}}
            raise ExtensionError(response.status_code, body)
        return response.json()


class ExtensionError(Exception):
    def __init__(self, status: int, body: dict):
        super().__init__(f"{status}: {body}")
        self.status = status
        self.body = body


def _error(status: int, code: str, message: str) -> dict:
    return {"ok": False, "status": status, "error": {"error": code, "message": message, "details": {}}}
