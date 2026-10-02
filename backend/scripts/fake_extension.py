"""Serve the in-memory FakeOneC over HTTP exactly like the 1C extension (docs/api-contract.md).

Lets the real agent, backend and web app run end to end without 1C:

    python -m scripts.fake_extension --port 8081 --token ext-token

Base URL for the agent: http://127.0.0.1:8081/TEST_CRYSTAL/hs/aiapi/v1
"""

from __future__ import annotations

import argparse
import json
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from tests.fake_1c import FakeOneC, OneCError, clean_base


def demo_base() -> FakeOneC:
    """The clean test base plus a year of sales and one planted error for several rules."""
    f = clean_base("OLD-DEBT")
    buyer = next(c for c in f.counterparties.values() if c["inn"] == "123456789")
    contract = next(c for c in f.contracts.values() if c["owner_ref"] == buyer["ref"])
    water = next(i for i in f.items.values() if i["name"].startswith("Вода"))
    cups = next(i for i in f.items.values() if i["name"] == "Стаканчики")
    start = date(2025, 10, 15)
    for m in range(11):
        day = (start + timedelta(days=30 * m)).isoformat()
        qty = 5 + m
        rows = [{"item_ref": water["ref"], "quantity": qty, "price": 10000, "vat_rate": 12}]
        f.add_document("sale", day, buyer, contract, rows)
        f.add_document("invoice_out", day, buyer, contract, rows)
        f.add_document("bank_in", day, buyer, contract, amount=qty * 11200)
    # Planted problems.
    f.add_counterparty("ИП Без ИНН", "12345", "1")                                        # NO-INN
    cups["ikpu_code"] = ""                                                                  # NO-IKPU (sold below)
    rows = [{"item_ref": cups["ref"], "quantity": 100, "price": 500, "vat_rate": 15}]       # VAT-RATE (item is 12%)
    f.add_document("sale", "2026-09-25", buyer, contract, rows)
    f.add_document("invoice_out", "2026-09-25", buyer, contract, rows)
    f.add_document("sale", "2026-09-26", buyer, None, [{"item_ref": water["ref"], "quantity": 1, "price": 10000, "vat_rate": 12}], posted=False)  # UNPOSTED + NO-CONTRACT
    return f


def make_handler(bases: dict[str, FakeOneC], token: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print("[fake-1c]", self.command, self.path)

        def _send(self, status: int, body):
            data = json.dumps(body, ensure_ascii=False, default=str).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _route(self, method: str):
            if self.headers.get("Authorization") != f"Bearer {token}":
                return self._send(401, {"error": "unauthorized", "message": "bad token", "details": {}})
            url = urlparse(self.path)
            parts = url.path.strip("/").split("/")
            if len(parts) < 4 or parts[1:3] != ["hs", "aiapi"] or parts[3] != "v1" or parts[0] not in bases:
                return self._send(404, {"error": "not_found", "message": url.path, "details": {}})
            base, rest = bases[parts[0]], parts[4:]
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            if "refs" in q:
                q["refs"] = q["refs"].split(",")
            body = {}
            if method == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
            try:
                if method == "GET" and rest == ["ping"]:
                    data = base.cmd_ping()
                elif method == "GET" and rest[0] == "catalogs":
                    data = base.cmd_get_catalog(rest[1], q.get("changed_since"), q.get("refs"))
                elif method == "GET" and rest[0] == "documents":
                    data = base.cmd_get_documents(rest[1], refs=q.get("refs"), **{k: q[k] for k in ("from", "to") if k in q})
                elif method == "GET" and rest == ["ledger"]:
                    data = base.cmd_get_ledger(refs=q.get("refs"), **{k: q[k] for k in ("from", "to") if k in q})
                elif method == "GET" and rest == ["balances"]:
                    data = base.cmd_get_balances(q["date"], q.get("account"))
                elif method == "GET" and rest == ["changes"]:
                    data = base.cmd_get_changes(q.get("since"))
                elif method == "POST" and rest == ["invoices"]:
                    data = base.cmd_create_invoice(**body)
                elif method == "POST" and len(rest) == 3 and rest[0] == "invoices" and rest[2] == "post":
                    data = base.cmd_post_invoice(body["approval_id"], rest[1], body.get("approved_by"))
                elif method == "POST" and rest == ["fixes"]:
                    data = base.cmd_apply_fix(**body)
                elif method == "GET" and rest[0] == "fixes":
                    data = base.cmd_get_fix(rest[1])
                else:
                    return self._send(404, {"error": "not_found", "message": url.path, "details": {}})
            except OneCError as e:
                return self._send(e.status, {"error": e.code, "message": e.message, "details": {}})
            return self._send(200, data)

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument("--token", default="ext-token")
    parser.add_argument("--bases", default="TEST_CRYSTAL", help="comma-separated base names")
    args = parser.parse_args()
    bases = {name: demo_base() for name in args.bases.split(",")}
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(bases, args.token))
    print(f"fake 1C extension on http://127.0.0.1:{args.port}/<BASE>/hs/aiapi/v1 for {list(bases)}")
    server.serve_forever()


if __name__ == "__main__":
    main()
