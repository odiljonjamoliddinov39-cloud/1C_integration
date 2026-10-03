"""The FakeOneC bases served over HTTP as 1C's standard OData interface (`/odata/standard.odata/`).

Lets the same tests run on both transports: through the agent and the AIAPI extension, and
directly over OData (services/odata.py). Only what the connector uses is implemented: $metadata,
collections with $filter/$select/$orderby/$top/$skip/$inlinecount, single entities, POST, PATCH,
the Post/Unpost actions and the accounting register's RecordsWithExtDimensions and Balance.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import uuid
from decimal import Decimal
from urllib.parse import unquote
from xml.sax.saxutils import quoteattr

import httpx

from tests.fake_1c import FakeOneC, OneCError, ref_

ZERO = "00000000-0000-0000-0000-000000000000"
NS = "StandardODATA"
LEDGER = "Хозрасчетный"
SUBCONTO_TYPES = {
    "counterparty_ref": "Catalog_Контрагенты",
    "contract_ref": "Catalog_ДоговорыКонтрагентов",
    "item_ref": "Catalog_Номенклатура",
    "warehouse_ref": "Catalog_Склады",
}
VAT_MEMBERS = ["НДС0", "НДС12", "НДС15", "БезНДС"]

# Entity types: properties and reference targets (as 1C describes them in $metadata).
OBJECT = {"Ref_Key": "Edm.Guid", "DataVersion": "Edm.String", "DeletionMark": "Edm.Boolean"}
TYPES: dict[str, tuple[dict, dict]] = {
    "Catalog_Организации": ({**OBJECT, "Description": "Edm.String", "ИНН": "Edm.String"}, {}),
    "Catalog_Контрагенты": ({**OBJECT, "Description": "Edm.String", "IsFolder": "Edm.Boolean", "ИНН": "Edm.String"}, {}),
    "Catalog_ДоговорыКонтрагентов": (
        {**OBJECT, "Description": "Edm.String", "Owner_Key": "Edm.Guid", "Номер": "Edm.String", "Дата": "Edm.DateTime"},
        {"Owner": "Catalog_Контрагенты"},
    ),
    "Catalog_Номенклатура": (
        {**OBJECT, "Description": "Edm.String", "IsFolder": "Edm.Boolean", "ЕдиницаИзмерения": "Edm.String",
         "Цена": "Edm.Double", "СтавкаНДС": "Edm.String", "КодИКПУ": "Edm.String"},
        {},
    ),
    "ChartOfAccounts_Хозрасчетный": ({"Ref_Key": "Edm.Guid", "Code": "Edm.String", "Description": "Edm.String"}, {}),
    "InformationRegister_ДатыЗапретаИзменения": (
        {"Пользователь": "Edm.String", "Пользователь_Type": "Edm.String", "Объект": "Edm.String", "ДатаЗапрета": "Edm.DateTime"},
        {},
    ),
    "AccountingRegister_Хозрасчетный": ({"Recorder": "Edm.String", "Period": "Edm.DateTime"}, {}),
}
DOC_PROPS = {
    **OBJECT, "Number": "Edm.String", "Date": "Edm.DateTime", "Posted": "Edm.Boolean",
    "Организация_Key": "Edm.Guid", "Контрагент_Key": "Edm.Guid", "ДоговорКонтрагента_Key": "Edm.Guid",
    "Склад_Key": "Edm.Guid", "СуммаДокумента": "Edm.Double", "СуммаВключаетНДС": "Edm.Boolean",
    "Комментарий": "Edm.String",
}
DOC_NAVS = {"Организация": "Catalog_Организации", "Контрагент": "Catalog_Контрагенты",
            "ДоговорКонтрагента": "Catalog_ДоговорыКонтрагентов", "Склад": "Catalog_Склады"}
ROW_PROPS = {"LineNumber": "Edm.Int64", "Номенклатура_Key": "Edm.Guid", "Количество": "Edm.Double", "Цена": "Edm.Double",
             "Сумма": "Edm.Double", "СтавкаНДС": "Edm.String", "СуммаНДС": "Edm.Double"}
for _name in FakeOneC.DOCUMENTS:
    TYPES[f"Document_{_name}"] = ({**DOC_PROPS, "Товары": f"Collection({NS}.Document_{_name}_Товары_RowType)"}, DOC_NAVS)
    TYPES[f"Document_{_name}_Товары_RowType"] = (ROW_PROPS, {"Номенклатура": "Catalog_Номенклатура"})


def metadata_xml() -> str:
    types, associations, sets = [], [], []
    for name, (props, navs) in TYPES.items():
        tag = "ComplexType" if name.endswith("_RowType") else "EntityType"
        body = "".join(f"<Property Name={quoteattr(p)} Type={quoteattr(t)}/>" for p, t in props.items())
        for nav, target in navs.items():
            assoc = f"{name}_{nav}"
            body += f'<NavigationProperty Name={quoteattr(nav)} Relationship={quoteattr(f"{NS}.{assoc}")} FromRole="Begin" ToRole="End"/>'
            associations.append(
                f'<Association Name={quoteattr(assoc)}><End Role="Begin" Type={quoteattr(f"{NS}.{name}")} Multiplicity="*"/>'
                f'<End Role="End" Type={quoteattr(f"{NS}.{target}")} Multiplicity="0..1"/></Association>'
            )
        types.append(f"<{tag} Name={quoteattr(name)}>{body}</{tag}>")
        if tag == "EntityType":
            sets.append(f"<EntitySet Name={quoteattr(name)} EntityType={quoteattr(f'{NS}.{name}')}/>")
    enum = "<EnumType Name=\"Enum_СтавкиНДС\">" + "".join(f"<Member Name=\"{m}\" Value=\"{i}\"/>" for i, m in enumerate(VAT_MEMBERS)) + "</EnumType>"
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0"><edmx:DataServices>'
        f'<Schema Namespace="{NS}" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">'
        + "".join(types) + "".join(associations) + enum
        + '<EntityContainer Name="InfoBase">' + "".join(sets) + "</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>"
    )


def acc_ref(code: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_OID, f"account:{code}"))


def vat_enum(rate) -> str:
    return "" if rate in (None, "") else f"НДС{int(Decimal(str(rate)))}"


def vat_number(value):
    if value in (None, ""):
        return None
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    return int(digits) if digits else 0


def with_version(row: dict) -> dict:
    row["DataVersion"] = hashlib.sha1(json.dumps(row, sort_keys=True, default=str).encode()).hexdigest()[:12]
    return row


class Fail(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message


# --- $filter: a small evaluator for the expressions the connector writes -----------------------------

TOKEN = re.compile(
    r"\s*(?:(?P<cast>cast\(guid'(?P<cg>[^']*)',\s*'[^']*'\))"
    r"|(?P<lit>(?:guid|datetime)?'(?P<lv>(?:[^']|'')*)')"
    r"|(?P<num>-?\d+(?:\.\d+)?)(?![\w-])"
    r"|(?P<par>[()])"
    r"|(?P<word>[^\s()']+))"
)
OPS = {"eq": "==", "ne": "!=", "ge": ">=", "le": "<=", "gt": ">", "lt": "<", "and": "and", "or": "or", "not": "not",
       "true": "True", "false": "False"}


def compile_filter(text: str):
    out, pos = [], 0
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m or m.end() == pos:
            if text[pos:].strip() == "":
                break
            raise Fail(400, f"Bad $filter near {text[pos:]!r}")
        pos = m.end()
        if m.group("cast"):
            out.append(repr(m.group("cg")))
        elif m.group("lit") is not None:
            out.append(repr(m.group("lv").replace("''", "'")))
        elif m.group("num"):
            out.append(m.group("num"))
        elif m.group("par"):
            out.append(m.group("par"))
        else:
            word = m.group("word")
            out.append(OPS.get(word, f"_r.get({word!r})"))
    code = compile(" ".join(out), "<filter>", "eval")
    return lambda row: eval(code, {}, {"_r": row})  # noqa: S307 - test helper over our own expressions


# --- the server --------------------------------------------------------------------------------------


class FakeODataServer:
    def __init__(self, bases: dict[str, FakeOneC] | None = None, username: str = "odata", password: str = "secret"):
        self.bases = bases if bases is not None else {}
        self.auth = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
        self.requests: list[tuple[str, str]] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = unquote(request.url.path)
        self.requests.append((request.method, path))
        parts = path.strip("/").split("/", 3)
        if len(parts) < 3 or parts[1:3] != ["odata", "standard.odata"] or parts[0] not in self.bases:
            return httpx.Response(404, text="<html>Not found</html>")
        if request.headers.get("authorization") != self.auth:
            return _error(401, "Не удалось выполнить аутентификацию")
        base = self.bases[parts[0]]
        rest = parts[3] if len(parts) > 3 else ""
        query = dict(request.url.params)
        try:
            if rest == "$metadata":
                return httpx.Response(200, text=metadata_xml(), headers={"Content-Type": "application/xml"})
            body = json.loads(request.content) if request.content else None
            return BaseView(base).route(request.method, rest, query, body)
        except Fail as e:
            return _error(e.status, e.message)
        except OneCError as e:
            return _error(500 if e.status == 409 else e.status, "Нарушение даты запрета изменения" if e.status == 409 else e.message)


ROUTE = re.compile(r"^(?P<set>[^/(]+)(?:\((?P<key>[^)]*)\))?(?:/(?P<sub>[^/(]+)(?:\((?P<args>.*)\))?)?$")


class BaseView:
    """One FakeOneC base as OData entities."""

    def __init__(self, f: FakeOneC):
        self.f = f
        self.org_ref = str(uuid.uuid5(uuid.NAMESPACE_OID, f"org:{f.name}"))

    # --- FakeOneC -> OData ------------------------------------------------------------------------

    def _doc_name(self, doc_type: str) -> str:
        return next(n for n, t in FakeOneC.DOCUMENTS.items() if t == doc_type)

    def document(self, d: dict) -> dict:
        rows = d.get("rows") or []
        return with_version({
            "Ref_Key": d["ref"], "DeletionMark": d["deleted"], "Number": d["number"], "Date": d["date"][:19],
            "Posted": d["posted"], "Организация_Key": self.org_ref, "Контрагент_Key": d.get("counterparty_ref") or ZERO,
            "ДоговорКонтрагента_Key": d.get("contract_ref") or ZERO,
            "Склад_Key": rows[0].get("warehouse_ref", ZERO) if rows else ZERO,
            "СуммаДокумента": float(Decimal(str(d.get("amount") or 0))), "СуммаВключаетНДС": False, "Комментарий": "",
            "Товары": [
                {"LineNumber": i, "Номенклатура_Key": r["item_ref"], "Количество": float(Decimal(str(r["quantity"]))),
                 "Цена": float(Decimal(str(r["price"]))), "Сумма": float(Decimal(str(r["amount"]))),
                 "СтавкаНДС": vat_enum(r.get("vat_rate")), "СуммаНДС": float(Decimal(str(r["vat_amount"])))}
                for i, r in enumerate(rows, start=1)
            ],
        })

    def catalog(self, name: str, o: dict) -> dict:
        row = {"Ref_Key": o["ref"], "DeletionMark": o.get("deleted", False), "Description": o.get("name", "")}
        if name == "Контрагенты":
            row.update({"IsFolder": False, "ИНН": o.get("inn", "")})
        elif name == "Номенклатура":
            row.update({"IsFolder": False, "ЕдиницаИзмерения": o.get("unit", ""), "Цена": float(o.get("price") or 0),
                        "СтавкаНДС": vat_enum(o.get("vat_rate")), "КодИКПУ": o.get("ikpu_code", "")})
        elif name == "ДоговорыКонтрагентов":
            row.update({"Owner_Key": o.get("owner_ref") or ZERO, "Номер": o.get("number", ""),
                        "Дата": f"{o['date']}T00:00:00" if o.get("date") else "0001-01-01T00:00:00"})
        return with_version(row)

    def _store(self, name: str) -> dict:
        return {"Контрагенты": self.f.counterparties, "Номенклатура": self.f.items, "ДоговорыКонтрагентов": self.f.contracts}[name]

    def rows(self, entity_set: str) -> list[dict]:
        kind, _, name = entity_set.partition("_")
        if entity_set == "Catalog_Организации":
            return [with_version({"Ref_Key": self.org_ref, "DeletionMark": False, "Description": self.f.name, "ИНН": self.f.inn})]
        if kind == "Catalog" and name in ("Контрагенты", "Номенклатура", "ДоговорыКонтрагентов"):
            return [self.catalog(name, o) for o in self._store(name).values()]
        if kind == "Document" and name in FakeOneC.DOCUMENTS:
            return [self.document(d) for d in self.f.documents.values() if d["type"] == FakeOneC.DOCUMENTS[name]]
        if entity_set == f"ChartOfAccounts_{LEDGER}":
            codes = {e[k] for es in self.f.entries.values() for e in es for k in ("dt", "kt")} | {o["account"] for o in self.f.opening}
            return [{"Ref_Key": acc_ref(c), "Code": c, "Description": c} for c in sorted(codes)]
        if entity_set == "InformationRegister_ДатыЗапретаИзменения":
            if not self.f.closed_until:
                return []
            return [{"Пользователь": "ДляВсехПользователей", "Пользователь_Type": f"{NS}.Enum_ВидыНазначенияДатЗапрета",
                     "Объект": "", "ДатаЗапрета": f"{self.f.closed_until.isoformat()}T00:00:00"}]
        raise Fail(404, f"Не найден ресурс {entity_set}")

    def _slots(self, sub: dict, prefix: str) -> dict:
        out, i = {}, 1
        for key, odata_type in SUBCONTO_TYPES.items():
            if sub.get(key) and i <= 3:
                out[f"{prefix}{i}"] = sub[key]
                out[f"{prefix}{i}_Type"] = f"{NS}.{odata_type}"
                i += 1
        return out

    def ledger(self) -> list[dict]:
        out = []
        for doc_ref, entries in self.f.entries.items():
            doc = self.f.documents.get(doc_ref)
            for e in entries:
                sdt, skt = e["subconto"].get("dt") or {}, e["subconto"].get("kt") or {}
                out.append({
                    "Recorder": doc_ref, "Recorder_Type": f"{NS}.Document_{self._doc_name(doc['type'])}" if doc else "",
                    "Period": e["date"][:19], "AccountDr_Key": acc_ref(e["dt"]), "AccountCr_Key": acc_ref(e["kt"]),
                    "Сумма": float(Decimal(str(e["amount"]))),
                    "КоличествоDr": float(sdt["quantity"]) if sdt.get("quantity") is not None else 0,
                    "КоличествоCr": float(skt["quantity"]) if skt.get("quantity") is not None else 0,
                    **self._slots(sdt, "ExtDimensionDr"), **self._slots(skt, "ExtDimensionCr"),
                })
        return out

    def balances(self) -> list[dict]:
        return [
            {"Account_Key": acc_ref(o["account"]), "СуммаBalanceDr": float(o["debit"]), "СуммаBalanceCr": float(o["credit"]),
             "КоличествоBalanceDr": float(o["quantity"]) if o.get("quantity") is not None else 0, "КоличествоBalanceCr": 0,
             **self._slots(o.get("subconto") or {}, "ExtDimension")}
            for o in self.f.opening
        ]

    # --- routing ----------------------------------------------------------------------------------

    def route(self, method: str, rest: str, query: dict, body):
        m = ROUTE.match(rest)
        if not m:
            raise Fail(404, rest)
        entity_set, key, sub, args = m.group("set", "key", "sub", "args")
        if entity_set == f"AccountingRegister_{LEDGER}" and method == "GET":
            if sub == "RecordsWithExtDimensions":
                rows = self.ledger()
                bounds = dict(re.findall(r"(\w+)=datetime'([^']*)'", args or ""))
                if bounds:
                    rows = [r for r in rows if bounds["StartPeriod"] <= r["Period"] <= bounds["EndPeriod"]]
                return self._collection(rows, query)
            if sub == "Balance":
                return self._collection(self.balances(), query)
            raise Fail(404, sub or entity_set)
        if key is None:
            if method == "GET":
                return self._collection(self.rows(entity_set), query)
            if method == "POST":
                return _json(201, self.create(entity_set, body or {}))
            raise Fail(405, method)
        ref = re.fullmatch(r"guid'([^']*)'", key).group(1)
        obj, kind, name = self._find(entity_set, ref)
        if sub in ("Post", "Unpost") and method == "POST":
            if kind != "Document":
                raise Fail(400, "Только документы проводятся")
            self.f._check_period(obj["date"])
            if sub == "Post":
                if obj["deleted"]:
                    raise Fail(400, "Нельзя провести помеченный на удаление документ")
                self.f.post(obj)
            else:
                self.f.unpost(obj)
            return httpx.Response(200)
        if sub:
            raise Fail(404, sub)
        if method == "GET":
            return _json(200, self.document(obj) if kind == "Document" else self.catalog(name, obj))
        if method == "PATCH":
            self.update(kind, name, obj, body or {})
            return _json(200, self.document(obj) if kind == "Document" else self.catalog(name, obj))
        raise Fail(405, method)

    def _find(self, entity_set: str, ref: str):
        kind, _, name = entity_set.partition("_")
        if kind == "Document" and name in FakeOneC.DOCUMENTS:
            doc = self.f.documents.get(ref)
            if doc and doc["type"] == FakeOneC.DOCUMENTS[name]:
                return doc, kind, name
        elif kind == "Catalog" and name in ("Контрагенты", "Номенклатура", "ДоговорыКонтрагентов"):
            obj = self._store(name).get(ref)
            if obj:
                return obj, kind, name
        else:
            self.rows(entity_set)  # 404 for unknown sets
        raise Fail(404, "Объект не найден")

    def _collection(self, rows: list[dict], query: dict) -> httpx.Response:
        if query.get("$filter"):
            match = compile_filter(query["$filter"])
            rows = [r for r in rows if match(r)]
        if query.get("$orderby"):
            field = query["$orderby"].split()[0]
            rows = sorted(rows, key=lambda r: str(r.get(field, "")))
        count = len(rows)
        skip, top = int(query.get("$skip") or 0), query.get("$top")
        rows = rows[skip : skip + int(top)] if top else rows[skip:]
        if query.get("$select"):
            keep = query["$select"].split(",")
            rows = [{k: r.get(k) for k in keep} for r in rows]
        out = {"value": rows}
        if query.get("$inlinecount") == "allpages":
            out["odata.count"] = str(count)
        return _json(200, out)

    # --- writes -----------------------------------------------------------------------------------

    def create(self, entity_set: str, body: dict) -> dict:
        kind, _, name = entity_set.partition("_")
        if kind == "Document" and name in FakeOneC.DOCUMENTS:
            day = str(body.get("Date") or self.f.clock.isoformat())[:10]
            self.f._check_period(day)
            cp = self.f.counterparties.get(body.get("Контрагент_Key"))
            contract = self.f.contracts.get(body.get("ДоговорКонтрагента_Key"))
            rows = [
                {"item_ref": r["Номенклатура_Key"], "quantity": r.get("Количество", 0), "price": r.get("Цена", 0),
                 "vat_rate": vat_number(r.get("СтавкаНДС")) or 0}
                for r in body.get("Товары") or []
            ]
            doc = self.f.add_document(FakeOneC.DOCUMENTS[name], day, cp, contract, rows, posted=False,
                                      amount=body.get("СуммаДокумента"))
            return self.document(doc)
        if kind == "Catalog" and name in ("Контрагенты", "Номенклатура", "ДоговорыКонтрагентов"):
            obj = {"ref": ref_(), "name": "", "deleted": False}
            self.update(kind, name, obj, body)
            self._store(name)[obj["ref"]] = obj
            return self.catalog(name, obj)
        raise Fail(400, f"Нельзя создать {entity_set}")

    def update(self, kind: str, name: str, obj: dict, body: dict) -> None:
        if kind == "Document":
            self.f._check_period(obj["date"])
            if body.get("Date"):
                self.f._check_period(str(body["Date"]))
        fields = {"Description": "name", "DeletionMark": "deleted"}
        if kind == "Catalog":
            fields.update({
                "Контрагенты": {"ИНН": "inn", "IsFolder": None},
                "Номенклатура": {"КодИКПУ": "ikpu_code", "ЕдиницаИзмерения": "unit", "Цена": "price", "IsFolder": None},
                "ДоговорыКонтрагентов": {"Owner_Key": "owner_ref", "Номер": "number"},
            }[name])
        else:
            fields.update({"Number": "number", "Контрагент_Key": "counterparty_ref", "ДоговорКонтрагента_Key": "contract_ref",
                           "СуммаДокумента": "amount", "Организация_Key": None, "СуммаВключаетНДС": None, "Комментарий": None,
                           "Склад_Key": None, "Posted": None})
        for key, value in body.items():
            if key == "СтавкаНДС" and kind == "Catalog" and name == "Номенклатура":
                obj["vat_rate"] = vat_number(value)
            elif key == "Дата" and name == "ДоговорыКонтрагентов":
                obj["date"] = str(value)[:10]
            elif key == "Date" and kind == "Document":
                obj["date"] = str(value)[:19]
            elif key == "Товары" and kind == "Document":
                self._rows(obj, value)
            elif key in fields:
                if fields[key]:
                    obj[fields[key]] = None if value == ZERO else (str(value) if fields[key] == "amount" else value)
            else:
                raise Fail(400, f"Неизвестное свойство {key}")
        if kind == "Catalog":
            self.f._register("catalog", name={"Контрагенты": "counterparties", "Номенклатура": "items",
                                              "ДоговорыКонтрагентов": "contracts"}[name], ref=obj["ref"], deleted=obj.get("deleted", False))

    def _rows(self, doc: dict, lines: list[dict]) -> None:
        old = doc.get("rows") or []
        warehouse = old[0].get("warehouse_ref", "W1") if old else "W1"
        rows = []
        for line in lines:
            qty, price = Decimal(str(line.get("Количество", 0))), Decimal(str(line.get("Цена", 0)))
            amount = Decimal(str(line["Сумма"])) if "Сумма" in line else qty * price
            rate = vat_number(line.get("СтавкаНДС")) or 0
            vat = Decimal(str(line["СуммаНДС"])) if "СуммаНДС" in line else (amount * rate / 100).quantize(Decimal("0.01"))
            rows.append({"item_ref": line.get("Номенклатура_Key"), "quantity": str(qty.normalize()), "price": str(price.normalize()),
                         "amount": str(amount), "vat_rate": rate, "vat_amount": str(vat), "warehouse_ref": warehouse})
        doc["rows"] = rows
        doc["vat"] = str(sum((Decimal(r["vat_amount"]) for r in rows), Decimal(0)))
        doc["amount"] = str(sum((Decimal(r["amount"]) for r in rows), Decimal(0)) + Decimal(doc["vat"]))


def _json(status: int, data) -> httpx.Response:
    return httpx.Response(status, content=json.dumps(data, ensure_ascii=False, default=str).encode(),
                          headers={"Content-Type": "application/json"})


def _error(status: int, message: str) -> httpx.Response:
    return _json(status, {"odata.error": {"code": str(status), "message": {"lang": "ru", "value": message}}})
