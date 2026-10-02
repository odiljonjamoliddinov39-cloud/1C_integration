"""An in-memory stand-in for a 1C base + the aiapi extension, speaking the agent command protocol.

It follows docs/api-contract.md: read endpoints, posting that produces journal entries, the write
endpoints with approval_id (applied once; repeats return the stored result), closed-period
refusal (409) and the change registration used by /changes.
"""

from __future__ import annotations

import copy
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

D = Decimal


def ref() -> str:
    return str(uuid.uuid4())


class FakeOneC:
    def __init__(self, inn="300000001", name="TEST_CRYSTAL"):
        self.inn = inn
        self.name = name
        self.closed_until: date | None = None
        self.counterparties: dict[str, dict] = {}
        self.contracts: dict[str, dict] = {}
        self.items: dict[str, dict] = {}
        self.documents: dict[str, dict] = {}
        self.entries: dict[str, list[dict]] = {}
        self.opening: list[dict] = []  # balances at the start of the sync window
        self.approvals: dict[str, dict] = {}
        self.changes: list[tuple[str, dict]] = []
        self.calls: list[tuple[str, dict]] = []
        self.clock = datetime(2026, 10, 1, 12, 0, 0)
        self.journal: list[dict] = []  # ЖурналИзмененийAI

    # --- building data ---------------------------------------------------------------------

    def _tick(self) -> str:
        self.clock += timedelta(seconds=1)
        return self.clock.isoformat()

    def _register(self, kind: str, **info):
        self.changes.append((self._tick(), {"kind": kind, **info}))

    def add_counterparty(self, name, inn, contract_number="1"):
        cp = {"ref": ref(), "name": name, "inn": inn, "deleted": False}
        self.counterparties[cp["ref"]] = cp
        self._register("catalog", name="counterparties", ref=cp["ref"], deleted=False)
        contract = None
        if contract_number is not None:
            contract = {"ref": ref(), "owner_ref": cp["ref"], "name": f"Договор №{contract_number}", "number": contract_number, "date": "2025-01-01", "deleted": False}
            self.contracts[contract["ref"]] = contract
            self._register("catalog", name="contracts", ref=contract["ref"], deleted=False)
        return cp, contract

    def add_item(self, name, vat_rate=12, ikpu="10202001001000000", price=10000, unit="шт"):
        item = {"ref": ref(), "name": name, "unit": unit, "price": price, "vat_rate": vat_rate, "ikpu_code": ikpu, "deleted": False}
        self.items[item["ref"]] = item
        self._register("catalog", name="items", ref=item["ref"], deleted=False)
        return item

    def add_document(self, type, day, cp=None, contract=None, rows=None, amount=None, posted=True, number=None, warehouse="W1"):
        rows = [dict(r) for r in (rows or [])]
        for r in rows:
            r.setdefault("warehouse_ref", warehouse)
            r["amount"] = str(D(str(r["quantity"])) * D(str(r["price"])))
            r["vat_amount"] = str((D(r["amount"]) * D(str(r["vat_rate"])) / 100).quantize(D("0.01")))
        vat = sum((D(r["vat_amount"]) for r in rows), D("0"))
        total = sum((D(r["amount"]) for r in rows), D("0")) + vat if rows else D(str(amount or 0))
        doc = {
            "ref": ref(),
            "type": type,
            "number": number or str(len(self.documents) + 1).zfill(6),
            "date": f"{day}T10:00:00",
            "posted": False,
            "deleted": False,
            "counterparty_ref": cp["ref"] if cp else None,
            "contract_ref": contract["ref"] if contract else None,
            "amount": str(total),
            "vat": str(vat),
            "rows": rows,
        }
        self.documents[doc["ref"]] = doc
        if posted:
            self.post(doc)
        else:
            self._register("document", type=type, ref=doc["ref"], deleted=False)
        return doc

    def post(self, doc: dict):
        """Generate journal entries the way the 1C posting would."""
        cp = {"counterparty_ref": doc["counterparty_ref"], "contract_ref": doc["contract_ref"]}
        when = doc["date"]
        out = []

        def entry(dt, kt, amount, sdt=None, skt=None):
            out.append({"document_ref": doc["ref"], "date": when, "dt": dt, "kt": kt, "amount": str(amount), "subconto": {"dt": sdt or {}, "kt": skt or {}}})

        t = doc["type"]
        if t == "sale":
            for r in doc["rows"]:
                entry("4010", "9010", r["amount"], cp, {})
                if D(r["vat_amount"]):
                    entry("4010", "6410", r["vat_amount"], cp, {})
                entry("9110", "2910", r["amount"], {}, {"item_ref": r["item_ref"], "warehouse_ref": r["warehouse_ref"], "quantity": r["quantity"]})
        elif t == "purchase":
            for r in doc["rows"]:
                entry("2910", "6010", r["amount"], {"item_ref": r["item_ref"], "warehouse_ref": r["warehouse_ref"], "quantity": r["quantity"]}, cp)
                if D(r["vat_amount"]):
                    entry("4410", "6010", r["vat_amount"], {}, cp)
        elif t == "bank_in":
            entry("5110", "4010", doc["amount"], {}, cp)
        elif t == "cash_in":
            entry("5010", "4010", doc["amount"], {}, cp)
        elif t == "cash_out":
            entry("6010", "5010", doc["amount"], cp, {})
        elif t == "bank_out":
            entry("6010", "5110", doc["amount"], cp, {})
        doc["posted"] = True
        self.entries[doc["ref"]] = out
        self._register("document", type=t, ref=doc["ref"], deleted=False)

    def unpost(self, doc: dict):
        doc["posted"] = False
        self.entries.pop(doc["ref"], None)
        self._register("document", type=doc["type"], ref=doc["ref"], deleted=doc["deleted"])

    def set_opening(self, account, debit=0, credit=0, quantity=None, **subconto):
        self.opening.append({"account": account, "subconto": subconto, "debit": str(debit), "credit": str(credit), "quantity": quantity})

    # --- protocol ------------------------------------------------------------------------------

    def __call__(self, company_id: int, command: str, params: dict) -> dict:
        self.calls.append((command, params))
        try:
            data = getattr(self, f"cmd_{command}")(**params)
            return {"ok": True, "data": data}
        except OneCError as e:
            return {"ok": False, "status": e.status, "error": {"error": e.code, "message": e.message, "details": {}}}

    def cmd_ping(self):
        return {"version": "1.0.0", "base_name": self.name, "inn": self.inn, "organization": self.name, "platform": "8.3.24.1342",
                "closed_period_until": self.closed_until.isoformat() if self.closed_until else None}

    def _changed_refs(self, since):
        return {c["ref"] for t, c in self.changes if since is None or t > since}

    def cmd_get_catalog(self, name, changed_since=None, refs=None):
        source = {"counterparties": self.counterparties, "contracts": self.contracts, "items": self.items}[name]
        rows = list(source.values())
        if changed_since:
            changed = self._changed_refs(changed_since)
            rows = [r for r in rows if r["ref"] in changed]
        if refs:
            rows = [r for r in rows if r["ref"] in refs]
        return {"name": name, "items": copy.deepcopy(rows)}

    def cmd_get_documents(self, type, refs=None, **period):
        rows = [d for d in self.documents.values() if d["type"] == type]
        if refs:
            rows = [d for d in rows if d["ref"] in refs]
        else:
            rows = [d for d in rows if period["from"] <= d["date"][:10] <= period["to"]]
        return {"type": type, "items": copy.deepcopy(rows)}

    def cmd_get_ledger(self, refs=None, **period):
        out = []
        for doc_ref, entries in self.entries.items():
            if refs is not None:
                if doc_ref in refs:
                    out.extend(entries)
            elif any(period["from"] <= e["date"][:10] <= period["to"] for e in entries):
                out.extend(entries)
        return {"items": copy.deepcopy(out)}

    def cmd_get_balances(self, date, account=None):
        return {"date": date, "items": copy.deepcopy(self.opening)}

    def cmd_get_changes(self, since=None):
        cursor = self.changes[-1][0] if self.changes else self.clock.isoformat()
        if since is None:
            return {"cursor": cursor, "items": []}
        items = [c for t, c in self.changes if t > since]
        return {"cursor": cursor, "items": items}

    # --- writes ----------------------------------------------------------------------------------

    def _approved(self, approval_id):
        if not approval_id:
            raise OneCError(400, "approval_required", "approval_id is required")
        return self.approvals.get(approval_id)

    def _check_period(self, day: str):
        if self.closed_until and date.fromisoformat(day[:10]) <= self.closed_until:
            raise OneCError(409, "closed_period", "Period is closed (ДатаЗапретаИзменения)")

    def cmd_create_invoice(self, approval_id, date, buyer_ref, contract_ref, rows, **_):
        if (prev := self._approved(approval_id)) is not None:
            return prev
        self._check_period(date)
        doc_rows = [{"item_ref": r["item_ref"], "quantity": r["quantity"], "price": r["price"], "vat_rate": r["vat_rate"]} for r in rows]
        doc = self.add_document("invoice_out", date, self.counterparties[buyer_ref], self.contracts[contract_ref], doc_rows, posted=False)
        result = {"ref": doc["ref"], "number": doc["number"], "date": doc["date"], "total": doc["amount"], "vat": doc["vat"], "posted": False}
        self.approvals[approval_id] = result
        self.journal.append({"approval_id": approval_id, "object": doc["ref"], "before": None, "after": result})
        return result

    def cmd_post_invoice(self, approval_id, ref):
        if (prev := self._approved(approval_id)) is not None:
            return prev
        doc = self.documents.get(ref)
        if not doc:
            raise OneCError(404, "not_found", "Invoice not found")
        self._check_period(doc["date"])
        self.post(doc)
        result = {"ref": ref, "posted": True}
        self.approvals[approval_id] = result
        return result

    def cmd_get_fix(self, id):
        return self.approvals.get(id)

    def cmd_apply_fix(self, approval_id, type, object, changes, fix_id=None, reverse_of=None):
        if (prev := self._approved(approval_id)) is not None:
            return prev
        kind, obj_ref = object["kind"], object["ref"]
        if kind == "document":
            doc = self.documents[obj_ref]
            self._check_period(doc["date"])
        if type == "restore":
            before, after = self._restore(reverse_of, object, changes)
        elif type == "fill_field":
            field, value = changes["field"], changes["value"]
            target = {"counterparty": self.counterparties, "item": self.items, "document": self.documents}[kind][obj_ref]
            before = {"field": field, "value": target.get(field)}
            target[field] = value
            after = {"field": field, "value": value}
            if kind == "document":
                if doc["posted"]:
                    self.post(doc)
            else:
                self._register("catalog", name={"counterparty": "counterparties", "item": "items"}[kind], ref=obj_ref, deleted=False)
        elif type == "repost":
            before = {"posted": doc["posted"]}
            self.post(doc)
            after = {"posted": True}
        elif type == "correct_vat":
            before = {"rows": [{"row": r["row"], "vat_rate": doc["rows"][r["row"] - 1]["vat_rate"]} for r in changes["rows"]]}
            for r in changes["rows"]:
                doc["rows"][r["row"] - 1]["vat_rate"] = r["vat_rate"]
            self.post(doc)
            after = {"rows": changes["rows"]}
        elif type == "reverse_duplicate":
            before = {"posted": doc["posted"], "deletion_mark": doc["deleted"]}
            doc["deleted"] = True
            self.unpost(doc)
            after = {"posted": False, "deletion_mark": True}
        elif type == "merge_counterparties":
            main = changes["main_ref"]
            moved = []
            for d in changes["documents"]:
                document = self.documents[d["ref"]]
                moved.append(d["ref"])
                document["counterparty_ref"] = main
                if document["posted"]:
                    self.post(document)
            self.counterparties[obj_ref]["deleted"] = True
            self._register("catalog", name="counterparties", ref=obj_ref, deleted=True)
            before = {"counterparty_ref": obj_ref, "documents": moved, "deletion_mark": False}
            after = {"counterparty_ref": main, "documents": moved, "deletion_mark": True}
        else:
            raise OneCError(400, "unknown_fix", type)
        result = {"fix_id": fix_id, "before": before, "after": after}
        self.approvals[approval_id] = result
        self.journal.append({"approval_id": approval_id, "object": obj_ref, "before": before, "after": after})
        return result

    def _restore(self, reverse_of, object, changes):
        snapshot = changes["restore"]
        kind, obj_ref = object["kind"], object["ref"]
        if reverse_of == "fill_field":
            target = {"counterparty": self.counterparties, "item": self.items, "document": self.documents}[kind][obj_ref]
            before = {"field": snapshot["field"], "value": target.get(snapshot["field"])}
            target[snapshot["field"]] = snapshot["value"]
            if kind == "document" and target["posted"]:
                self.post(target)
            return before, snapshot
        if reverse_of == "correct_vat":
            doc = self.documents[obj_ref]
            before = {"rows": [{"row": r["row"], "vat_rate": doc["rows"][r["row"] - 1]["vat_rate"]} for r in snapshot["rows"]]}
            for r in snapshot["rows"]:
                doc["rows"][r["row"] - 1]["vat_rate"] = r["vat_rate"]
            self.post(doc)
            return before, snapshot
        if reverse_of == "reverse_duplicate":
            doc = self.documents[obj_ref]
            doc["deleted"] = snapshot["deletion_mark"]
            if snapshot["posted"]:
                self.post(doc)
            return {"posted": False, "deletion_mark": True}, snapshot
        if reverse_of == "merge_counterparties":
            for d in snapshot["documents"]:
                document = self.documents[d]
                document["counterparty_ref"] = snapshot["counterparty_ref"]
                if document["posted"]:
                    self.post(document)
            self.counterparties[obj_ref]["deleted"] = False
            self._register("catalog", name="counterparties", ref=obj_ref, deleted=False)
            return {"deletion_mark": True}, snapshot
        if reverse_of == "repost":
            return {}, snapshot
        raise OneCError(400, "unknown_fix", f"cannot restore {reverse_of}")


class OneCError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


# --- the clean dataset used by the tests --------------------------------------------------------

TODAY = date(2026, 10, 2)


def clean_base(plant: str | None = None) -> FakeOneC:
    """A small, consistent base on which no audit rule fires. `plant` adds one error for one rule."""
    f = FakeOneC()
    buyer, c1 = f.add_counterparty("ООО Покупатель", "123456789", "15")
    supplier, c2 = f.add_counterparty("ООО Поставщик", "987654321", "7")
    water = f.add_item("Вода питьевая 19л", vat_rate=12, ikpu="10202001001000000", price=10000)
    f.add_item("Стаканчики", vat_rate=12, ikpu="10202001001000001", price=500)

    opening_qty = 0 if plant == "NEG-STOCK" else 100
    f.set_opening("5010", debit=1_000_000)
    if opening_qty:
        f.set_opening("2910", debit=500_000, quantity=opening_qty, item_ref=water["ref"], warehouse_ref="W1")

    purchase_day = "2026-09-10" if plant == "NEG-STOCK" else "2026-09-01"
    f.add_document("purchase", purchase_day, supplier, c2, [{"item_ref": water["ref"], "quantity": 50, "price": 5000, "vat_rate": 12}])
    sale = f.add_document("sale", "2026-09-05", buyer, c1, [{"item_ref": water["ref"], "quantity": 20, "price": 10000, "vat_rate": 12}])
    invoice = f.add_document("invoice_out", "2026-09-05", buyer, c1, [{"item_ref": water["ref"], "quantity": 20, "price": 10000, "vat_rate": 12}])
    f.add_document("bank_in", "2026-09-20", buyer, c1, amount=224000)
    f.add_document("cash_out", "2026-09-10", supplier, c2, amount=280000)

    if plant == "CASH-NEG":
        f.add_document("cash_out", "2026-09-15", supplier, c2, amount=900000)
    elif plant == "DUP-DOC":
        f.add_document("bank_in", "2026-09-20", buyer, c1, amount=224000)
    elif plant == "DUP-CP":
        f.add_counterparty("Покупатель ООО (дубль)", "123456789", None)
    elif plant == "NO-INN":
        f.add_counterparty("ИП Без ИНН", "12345", "1")
    elif plant == "NO-IKPU":
        water["ikpu_code"] = ""
    elif plant == "VAT-RATE":
        sale["rows"][0]["vat_rate"] = 15  # label only: amounts and entries stay at 12%
    elif plant == "VAT-MISMATCH":
        invoice["vat"] = "20000"
    elif plant == "UNPOSTED":
        f.add_document("sale", "2026-09-20", buyer, c1, [{"item_ref": water["ref"], "quantity": 1, "price": 10000, "vat_rate": 12}], posted=False)
    elif plant == "ENTRY-MISMATCH":
        sale["amount"] = "230000"
    elif plant == "OLD-DEBT":
        late, c3 = f.add_counterparty("ООО Должник", "111222333", "3")
        rows = [{"item_ref": water["ref"], "quantity": 1, "price": 10000, "vat_rate": 12}]
        f.add_document("sale", "2026-05-04", late, c3, rows)
        f.add_document("invoice_out", "2026-05-04", late, c3, rows)
    elif plant == "NO-CONTRACT":
        sale["contract_ref"] = None
    return f
