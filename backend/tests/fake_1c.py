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


ref_ = ref  # inside FakeOneC, `ref` is often a parameter name


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
        self.queries: list[tuple] = []

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

    def cmd_post_invoice(self, approval_id, ref, approved_by=None):
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

    # --- generic object API (/metadata, /objects, /query) -------------------------------------

    CATALOGS = {
        "Контрагенты": ("counterparties", {"Наименование": "name"}, {"ИНН": "inn"}),
        "Номенклатура": ("items", {"Наименование": "name"}, {"КодИКПУ": "ikpu_code", "СтавкаНДС": "vat_rate", "ЕдиницаИзмерения": "unit", "Цена": "price"}),
        "ДоговорыКонтрагентов": ("contracts", {"Наименование": "name"}, {"Номер": "number"}),
    }
    DOCUMENTS = {
        "РеализацияТоваровУслуг": "sale", "ПоступлениеТоваровУслуг": "purchase", "СчетФактураВыданный": "invoice_out",
        "СчетФактураПолученный": "invoice_in", "ПриходныйКассовыйОрдер": "cash_in", "РасходныйКассовыйОрдер": "cash_out",
        "ПоступлениеНаРасчетныйСчет": "bank_in", "СписаниеСРасчетногоСчета": "bank_out",
    }
    ROW_FIELDS = {"Количество": "quantity", "Цена": "price", "Сумма": "amount", "СтавкаНДС": "vat_rate", "СуммаНДС": "vat_amount"}

    def _store(self, kind, name):
        if kind == "catalog" and name in self.CATALOGS:
            return getattr(self, self.CATALOGS[name][0])
        if kind == "document" and name in self.DOCUMENTS:
            return {r: d for r, d in self.documents.items() if d["type"] == self.DOCUMENTS[name]}
        raise OneCError(404, "not_found", f"{kind} {name} is not in this base")

    def _refobj(self, catalog, ref):
        if not ref:
            return None
        store = getattr(self, self.CATALOGS[catalog][0])
        return {"_type": f"Справочник.{catalog}", "ref": ref, "presentation": store.get(ref, {}).get("name", "")}

    def _describe(self, kind, name, obj):
        if kind == "catalog":
            _, std, attrs = self.CATALOGS[name]
            out = {
                "_type": f"Справочник.{name}", "ref": obj["ref"], "presentation": obj.get("name", ""), "deletion_mark": obj.get("deleted", False),
                "standard": {k: obj.get(v) for k, v in std.items()},
                "attributes": {k: obj.get(v) for k, v in attrs.items()},
                "tables": {},
            }
            if name == "ДоговорыКонтрагентов":
                out["standard"]["Владелец"] = self._refobj("Контрагенты", obj.get("owner_ref"))
            return out
        rows = [
            {"Номенклатура": self._refobj("Номенклатура", r["item_ref"]), **{k: r.get(v) for k, v in self.ROW_FIELDS.items()}}
            for r in obj.get("rows", [])
        ]
        return {
            "_type": f"Документ.{name}", "ref": obj["ref"], "presentation": f"{name} {obj['number']}", "deletion_mark": obj["deleted"],
            "posted": obj["posted"],
            "standard": {"Номер": obj["number"], "Дата": obj["date"]},
            "attributes": {
                "Контрагент": self._refobj("Контрагенты", obj.get("counterparty_ref")),
                "ДоговорКонтрагента": self._refobj("ДоговорыКонтрагентов", obj.get("contract_ref")),
                "СуммаДокумента": obj.get("amount"),
            },
            "tables": {"Товары": rows},
        }

    def cmd_get_metadata(self):
        catalogs = [
            {"name": n, "synonym": n, "attributes": [{"name": a} for a in attrs], "tabular_sections": []}
            for n, (_, _, attrs) in self.CATALOGS.items()
        ]
        documents = [
            {"name": n, "synonym": n, "posting": True, "attributes": [{"name": "Контрагент"}, {"name": "ДоговорКонтрагента"}, {"name": "СуммаДокумента"}],
             "tabular_sections": [{"name": "Товары", "attributes": [{"name": "Номенклатура"}, *[{"name": k} for k in self.ROW_FIELDS]]}]}
            for n in self.DOCUMENTS
        ]
        return {
            "configuration": "БухгалтерияДляУзбекистана", "version": "3.0.0", "base_name": self.name,
            "catalogs": catalogs, "documents": documents,
            "accounting_registers": [{"name": "Хозрасчетный", "dimensions": [], "resources": [{"name": "Сумма"}, {"name": "Количество"}]}],
            "accumulation_registers": [], "information_registers": [], "charts_of_accounts": [{"name": "Хозрасчетный"}], "enums": [],
        }

    def cmd_list_objects(self, kind, name, refs=None, filter=None, limit=100, offset=0, include_deleted=False, **period):
        rows = list(self._store(kind, name).values())
        if refs:
            rows = [r for r in rows if r["ref"] in refs]
        if kind == "document":
            if period.get("from"):
                rows = [r for r in rows if r["date"][:10] >= period["from"]]
            if period.get("to"):
                rows = [r for r in rows if r["date"][:10] <= period["to"]]
        if not include_deleted:
            rows = [r for r in rows if not r.get("deleted")]
        items = [self._describe(kind, name, r) for r in rows]
        for key, value in (filter or {}).items():
            items = [i for i in items if i["attributes"].get(key, i["standard"].get(key)) == value]
        total = len(items)
        return {"kind": kind, "name": name, "total": total, "items": items[int(offset): int(offset) + int(limit)]}

    def cmd_get_object(self, kind, name, ref):
        obj = self._store(kind, name).get(ref)
        if obj is None:
            raise OneCError(404, "not_found", "Object not found")
        return self._describe(kind, name, obj)

    def cmd_run_query(self, text, params=None, limit=1000):
        self.queries.append((text, params))
        if "Хозрасчетный.Остатки" in text:
            balance = {}
            for o in self.opening:
                balance[o["account"]] = balance.get(o["account"], D("0")) + D(o["debit"]) - D(o["credit"])
            for entries in self.entries.values():
                for e in entries:
                    balance[e["dt"]] = balance.get(e["dt"], D("0")) + D(e["amount"])
                    balance[e["kt"]] = balance.get(e["kt"], D("0")) - D(e["amount"])
            rows = [[acc, float(max(b, 0)), float(max(-b, 0))] for acc, b in sorted(balance.items()) if b]
            return {"columns": ["Счет", "СуммаОстатокДт", "СуммаОстатокКт"], "rows": rows[:limit], "truncated": len(rows) > limit}
        rows = [[d["ref"], d["number"], d["date"]] for d in self.documents.values()]
        return {"columns": ["Ссылка", "Номер", "Дата"], "rows": rows[:limit], "truncated": len(rows) > limit}

    def _apply_data(self, kind, name, obj, data):
        data = data or {}
        if kind == "catalog":
            _, std, attrs = self.CATALOGS[name]
            fields = {**std, **attrs}
            for part in ("standard", "attributes"):
                for k, v in (data.get(part) or {}).items():
                    if k not in fields:
                        raise OneCError(400, "bad_attribute", f"{name} has no attribute {k}")
                    obj[fields[k]] = v
            return
        std = data.get("standard") or {}
        if "Номер" in std:
            obj["number"] = std["Номер"]
        if "Дата" in std:
            obj["date"] = std["Дата"]
        for k, v in (data.get("attributes") or {}).items():
            field = {"Контрагент": "counterparty_ref", "ДоговорКонтрагента": "contract_ref", "СуммаДокумента": "amount"}.get(k)
            if field is None:
                raise OneCError(400, "bad_attribute", f"{name} has no attribute {k}")
            obj[field] = v.get("ref") if isinstance(v, dict) else v
        if "Товары" in (data.get("tables") or {}):
            rows = []
            for r in data["tables"]["Товары"]:
                row = {"item_ref": (r.get("Номенклатура") or {}).get("ref"), "warehouse_ref": "W1"}
                for k, v in self.ROW_FIELDS.items():
                    if k in r:
                        row[v] = r[k]
                row["amount"] = str(D(str(row.get("quantity", 0))) * D(str(row.get("price", 0))))
                row["vat_amount"] = str((D(row["amount"]) * D(str(row.get("vat_rate", 0))) / 100).quantize(D("0.01")))
                rows.append(row)
            obj["rows"] = rows
            obj["vat"] = str(sum((D(r["vat_amount"]) for r in rows), D("0")))
            obj["amount"] = str(sum((D(r["amount"]) for r in rows), D("0")) + D(obj["vat"]))

    def cmd_write_object(self, approval_id, kind, name, action, ref=None, data=None, post=None, snapshot=None, fix_id=None, approved_by=None):
        if (prev := self._approved(approval_id)) is not None:
            return prev
        if kind not in ("catalog", "document"):
            raise OneCError(400, "not_writable", "Only catalogs and documents can be changed")
        store = self._store(kind, name)
        before = None
        if action == "create":
            if kind == "catalog":
                obj = {"ref": ref_(), "name": "", "deleted": False}
                if name == "ДоговорыКонтрагентов":
                    obj["owner_ref"] = ((data or {}).get("standard") or {}).get("Владелец", {}).get("ref")
                self._apply_data(kind, name, obj, data)
                getattr(self, self.CATALOGS[name][0])[obj["ref"]] = obj
                self._register("catalog", name=self.CATALOGS[name][0], ref=obj["ref"], deleted=False)
            else:
                obj = {"ref": ref_(), "type": self.DOCUMENTS[name], "number": str(len(self.documents) + 1).zfill(6), "date": self.clock.isoformat(),
                       "posted": False, "deleted": False, "counterparty_ref": None, "contract_ref": None, "amount": "0", "vat": "0", "rows": []}
                self._apply_data(kind, name, obj, data)
                self._check_period(obj["date"])
                self.documents[obj["ref"]] = obj
                self.post(obj) if post else self._register("document", type=obj["type"], ref=obj["ref"], deleted=False)
        else:
            obj = store.get(ref)
            if obj is None:
                raise OneCError(404, "not_found", "Object not found")
            if kind == "document":
                self._check_period(obj["date"])
            before = self._describe(kind, name, obj)
            if action == "update":
                self._apply_data(kind, name, obj, data)
            elif action == "restore":
                self._apply_data(kind, name, obj, {k: snapshot.get(k) for k in ("standard", "attributes", "tables") if snapshot.get(k)})
                obj["deleted"] = snapshot.get("deletion_mark", False)
                if kind == "document" and not snapshot.get("posted", False) and obj["posted"]:
                    self.unpost(obj)
                    post = False
                elif kind == "document" and snapshot.get("posted"):
                    post = True
            elif action == "mark_deletion":
                obj["deleted"] = True
                if kind == "document" and obj["posted"]:
                    self.unpost(obj)
            elif action == "unmark_deletion":
                obj["deleted"] = False
            elif action == "post":
                post = True
            elif action == "unpost":
                self.unpost(obj)
            else:
                raise OneCError(400, "bad_action", action)
            if kind == "document" and (post or (action == "update" and obj["posted"])):
                self.post(obj)
            elif kind == "catalog":
                self._register("catalog", name=self.CATALOGS[name][0], ref=obj["ref"], deleted=obj.get("deleted", False))
        after = self._describe(kind, name, obj)
        result = {"fix_id": fix_id, "ref": obj["ref"], "before": before, "after": after}
        self.approvals[approval_id] = result
        self.journal.append({"approval_id": approval_id, "object": obj["ref"], "before": before, "after": after})
        return result

    def cmd_get_fix(self, id):
        return self.approvals.get(id)

    def cmd_apply_fix(self, approval_id, type, object, changes, fix_id=None, reverse_of=None, approved_by=None):
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
        invoice["rows"][0]["vat_amount"] = "20000"  # the row's VAT, as 1C stores it (СуммаНДС)
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
