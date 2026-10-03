"""Direct connection to a 1C base over its standard OData interface: no extension, no agent.

Every 1C base published on a web server can serve a built-in REST interface at
`<publication>/odata/standard.odata/`. A person types the address, a 1C username and a password in
the web app, and the backend talks to the base directly with HTTP Basic auth.

`ODataOneC.execute(command, params)` speaks the same command protocol as the agent and the
`aiapi` extension (docs/api-contract.md), and returns the same reply envelope. Sync, audit, fixes,
invoices and the direct object API therefore work unchanged on either transport.

What differs from the extension:

* No 1C query language (`run_query` returns 501): OData has its own filters only.
* Changes are found by comparing each object's `DataVersion` with the previous sync's snapshot,
  so no change-registration register is needed.
* A write that touches several objects (merging counterparties) is several HTTP calls, not one
  1C transaction. Each call is still checked by 1C itself (rights, closed period).
* The approval log lives in the backend (fixes, invoices, event_log), not in ЖурналИзмененийAI.

Configuration names are the same as in the extension's AIAPI_Метаданные. OData uses its own
English names for standard fields (Ref_Key, Description, Number, Date, Posted, DeletionMark ...)
and adds `_Key` to reference attributes (Контрагент_Key).
"""

from __future__ import annotations

import uuid
import xml.etree.ElementTree as ET
from collections.abc import Callable
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol
from urllib.parse import quote, urlsplit

import httpx

ZERO_GUID = "00000000-0000-0000-0000-000000000000"
ODATA_PATH = "odata/standard.odata/"

# --- names in the configuration (same as extension/src/CommonModules/AIAPI_Метаданные.bsl) ------

DOCUMENTS = {
    "sale": "РеализацияТоваровУслуг",
    "purchase": "ПоступлениеТоваровУслуг",
    "invoice_out": "СчетФактураВыданный",
    "invoice_in": "СчетФактураПолученный",
    "cash_in": "ПриходныйКассовыйОрдер",
    "cash_out": "РасходныйКассовыйОрдер",
    "bank_in": "ПоступлениеНаРасчетныйСчет",
    "bank_out": "СписаниеСРасчетногоСчета",
    "operation": "ОперацияБух",
}
CATALOGS = {
    "counterparties": "Контрагенты",
    "contracts": "ДоговорыКонтрагентов",
    "items": "Номенклатура",
    "warehouses": "Склады",
    "organizations": "Организации",
}
A = {
    "inn": "ИНН",
    "contract_number": "Номер",
    "contract_date": "Дата",
    "unit": "ЕдиницаИзмерения",
    "vat_rate": "СтавкаНДС",
    "ikpu": "КодИКПУ",
    "price": "Цена",
    "counterparty": "Контрагент",
    "contract": "ДоговорКонтрагента",
    "warehouse": "Склад",
    "organization": "Организация",
    "total": "СуммаДокумента",
    "rows": "Товары",
    "item": "Номенклатура",
    "quantity": "Количество",
    "row_price": "Цена",
    "row_amount": "Сумма",
    "row_vat_rate": "СтавкаНДС",
    "row_vat": "СуммаНДС",
    "vat_included": "СуммаВключаетНДС",
    "comment": "Комментарий",
}
LEDGER = "Хозрасчетный"
CLOSING_DATES = "ДатыЗапретаИзменения"
SUBCONTO = {
    "Catalog_Контрагенты": "counterparty_ref",
    "Catalog_ДоговорыКонтрагентов": "contract_ref",
    "Catalog_Номенклатура": "item_ref",
    "Catalog_Склады": "warehouse_ref",
}

# What a base must publish for sync, audit, fixes and invoices to work.
REQUIRED_SETS = (
    [f"Catalog_{n}" for n in ("Организации", "Контрагенты", "ДоговорыКонтрагентов", "Номенклатура")]
    + [f"Document_{n}" for n in DOCUMENTS.values()]
    + [f"AccountingRegister_{LEDGER}", f"ChartOfAccounts_{LEDGER}"]
)

# API kind -> OData prefix, and OData prefix -> 1C class name (as the extension writes `_type`).
PREFIX = {
    "catalog": "Catalog",
    "document": "Document",
    "information_register": "InformationRegister",
    "accumulation_register": "AccumulationRegister",
    "accounting_register": "AccountingRegister",
    "chart_of_accounts": "ChartOfAccounts",
    "chart_of_characteristic_types": "ChartOfCharacteristicTypes",
}
RU_CLASS = {
    "Catalog": "Справочник",
    "Document": "Документ",
    "ChartOfAccounts": "ПланСчетов",
    "ChartOfCharacteristicTypes": "ПланВидовХарактеристик",
    "ChartOfCalculationTypes": "ПланВидовРасчета",
    "ExchangePlan": "ПланОбмена",
    "BusinessProcess": "БизнесПроцесс",
    "Task": "Задача",
    "Enum": "Перечисление",
}
EN_CLASS = {v: k for k, v in RU_CLASS.items()}
# OData standard field -> name in the generic object shape (standard attributes).
STANDARD = {
    "Description": "Наименование",
    "Code": "Код",
    "Parent_Key": "Родитель",
    "Owner_Key": "Владелец",
    "Number": "Номер",
    "Date": "Дата",
    "IsFolder": "ЭтоГруппа",
}
STANDARD_BACK = {v: k for k, v in STANDARD.items()}
SYSTEM = {"Ref_Key", "DataVersion", "DeletionMark", "Predefined", "PredefinedDataName", "Posted", "LineNumber"}
NUMERIC = {"Edm.Double", "Edm.Decimal", "Edm.Int16", "Edm.Int32", "Edm.Int64", "Edm.Single"}
REF_CHUNK = 25


class ODataError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class SnapshotStore(Protocol):
    """Keeps the DataVersion of every mirrored object, per sync cursor."""

    def save(self, cursor: str, versions: dict) -> None: ...

    def load(self, cursor: str) -> dict | None: ...


class MemorySnapshots:
    def __init__(self):
        self.data: dict[str, dict] = {}

    def save(self, cursor: str, versions: dict) -> None:
        self.data[cursor] = versions

    def load(self, cursor: str) -> dict | None:
        return self.data.get(cursor)


def odata_url(address: str, base: str | None = None) -> str:
    """'192.168.1.10' + 'TEST_CRYSTAL' -> 'http://192.168.1.10/TEST_CRYSTAL/odata/standard.odata/'."""
    address = (address or "").strip()
    if not address:
        raise ValueError("Enter the server address")
    if "://" not in address:
        address = "http://" + address
    parts = urlsplit(address)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("The address must look like 192.168.1.10, server:8080 or http://server/base")
    path = parts.path.rstrip("/")
    if path.endswith("/odata/standard.odata"):
        path = path[: -len("/odata/standard.odata")]
    if base and base.strip().strip("/"):
        path = f"{path}/{base.strip().strip('/')}"
    if not path:
        raise ValueError("Enter the base (publication) name, e.g. TEST_CRYSTAL")
    return f"{parts.scheme}://{parts.netloc}{path}/{ODATA_PATH}"


def publication_name(url: str) -> str:
    path = urlsplit(url).path
    if "/odata/" in path:
        path = path.split("/odata/")[0]
    return path.rstrip("/").rsplit("/", 1)[-1]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _short(name: str | None) -> str:
    """'StandardODATA.Catalog_Контрагенты' -> 'Catalog_Контрагенты'."""
    return (name or "").rsplit(".", 1)[-1]


def ru_type(odata_type: str | None) -> str | None:
    """'StandardODATA.Catalog_Контрагенты' -> 'Справочник.Контрагенты'."""
    short = _short(odata_type)
    if "_" not in short:
        return None
    prefix, name = short.split("_", 1)
    return f"{RU_CLASS[prefix]}.{name}" if prefix in RU_CLASS else None


def odata_type(ru: str) -> str:
    """'Справочник.Контрагенты' -> 'StandardODATA.Catalog_Контрагенты'."""
    cls, _, name = ru.partition(".")
    if cls not in EN_CLASS or not name:
        raise ODataError(400, "bad_value", f"Unknown _type {ru}")
    return f"StandardODATA.{EN_CLASS[cls]}_{name}"


def is_ref(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 36 and value.count("-") == 4


def no_ref(value: Any) -> str | None:
    return None if not value or value == ZERO_GUID else value


def no_date(value: Any) -> str | None:
    if not value or str(value).startswith("0001-01-01"):
        return None
    return str(value)[:19]


def dt_literal(value: str, end_of_day: bool = False) -> str:
    text = str(value)[:19]
    if len(text) == 10:
        text += "T23:59:59" if end_of_day else "T00:00:00"
    return f"datetime'{text}'"


def num(value: Any) -> Decimal:
    try:
        return Decimal(str(value if value not in (None, "") else 0))
    except InvalidOperation:
        return Decimal(0)


class Schema:
    """The parts of `$metadata` the connector needs: properties, reference targets, sets, enums."""

    def __init__(self, xml_text: str):
        root = ET.fromstring(xml_text)
        associations: dict[str, dict[str, str]] = {}
        for el in root.iter():
            if _local(el.tag) == "Association":
                associations[el.get("Name")] = {
                    e.get("Role"): _short(e.get("Type")) for e in el if _local(e.tag) == "End"
                }
        self.types: dict[str, dict] = {}
        self.sets: dict[str, str] = {}
        self.enums: dict[str, list[str]] = {}
        for el in root.iter():
            tag = _local(el.tag)
            if tag in ("EntityType", "ComplexType"):
                props = {p.get("Name"): p.get("Type") for p in el if _local(p.tag) == "Property"}
                navs = {}
                for p in el:
                    if _local(p.tag) == "NavigationProperty":
                        target = associations.get(_short(p.get("Relationship")), {}).get(p.get("ToRole"))
                        if target:
                            navs[p.get("Name")] = target
                self.types[el.get("Name")] = {"props": props, "navs": navs}
            elif tag == "EntitySet":
                self.sets[el.get("Name")] = _short(el.get("EntityType"))
            elif tag == "EnumType":
                self.enums[el.get("Name")] = [m.get("Name") for m in el if _local(m.tag) == "Member"]

    def type_of(self, entity_set: str) -> str:
        return self.sets.get(entity_set, entity_set)

    def props(self, type_name: str) -> dict[str, str]:
        return self.types.get(type_name, {}).get("props", {})

    def ref_target(self, type_name: str, attr: str) -> str | None:
        """Entity type an `<attr>_Key` property points to, e.g. 'Catalog_Контрагенты'."""
        return self.types.get(type_name, {}).get("navs", {}).get(attr)

    def row_type(self, type_name: str, table: str) -> str | None:
        t = self.props(type_name).get(table, "")
        return _short(t[len("Collection(") : -1]) if t.startswith("Collection(") else None

    def tables(self, type_name: str) -> list[str]:
        return [n for n, t in self.props(type_name).items() if (t or "").startswith("Collection(")]

    def enum_like(self, word: str) -> list[str]:
        for name, members in self.enums.items():
            if word in name:
                return members
        return []


class ODataOneC:
    def __init__(
        self,
        url: str,
        username: str,
        password: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 60,
        snapshots: SnapshotStore | None = None,
        today: Callable[[], date] = date.today,
    ):
        self.url = url
        self.publication = publication_name(url)
        self.http = httpx.Client(
            auth=(username, password),
            timeout=timeout,
            transport=transport,
            headers={"Accept": "application/json"},
            trust_env=False,  # 1C is on the local network: never send it through an HTTP proxy
        )
        self.snapshots = snapshots or MemorySnapshots()
        self.today = today
        self._schema: Schema | None = None
        self._accounts: dict[str, str] | None = None
        self._vat_refs: dict[str, dict[str, Decimal]] = {}

    def close(self) -> None:
        self.http.close()

    # --- dispatch ------------------------------------------------------------------------------

    def execute(self, command: str, params: dict) -> dict:
        handler = getattr(self, f"cmd_{command}", None)
        if handler is None:
            return _error(400, "unknown_command", f"{command} is not supported over a direct connection")
        try:
            return {"ok": True, "data": handler(**params)}
        except ODataError as e:
            return _error(e.status, e.code, e.message)
        except httpx.TransportError as e:
            return _error(503, "onec_unreachable", f"Cannot reach 1C at {urlsplit(self.url).netloc}: {e}")
        except TypeError as e:
            return _error(400, "bad_params", str(e))

    # --- http ----------------------------------------------------------------------------------

    def _href(self, path: str, query: dict | None = None) -> str:
        href = self.url + quote(path, safe="/()'=,:_-.")
        q = {"$format": "json", **{k: v for k, v in (query or {}).items() if v not in (None, "")}}
        return href + "?" + "&".join(f"{k}={quote(str(v), safe=chr(39) + '(),:_-.$')}" for k, v in q.items())

    def _request(self, method: str, path: str, query: dict | None = None, body: Any = None) -> Any:
        response = self.http.request(method, self._href(path, query), json=body)
        if response.status_code >= 400:
            raise _odata_error(response, path)
        if not response.content:
            return None
        return response.json()

    def _get(self, path: str, **query) -> Any:
        return self._request("GET", path, query)

    def _rows(self, entity_set: str, **query) -> list[dict]:
        return self._get(entity_set, **query).get("value", [])

    def _rows_or_empty(self, entity_set: str, **query) -> list[dict]:
        """Rows of a set; an empty list if the base does not publish it."""
        try:
            return self._rows(entity_set, **query)
        except ODataError as e:
            if e.status == 404:
                return []
            raise

    def _by_refs(self, entity_set: str, refs: list[str], extra: str | None = None, **query) -> list[dict]:
        out = []
        for i in range(0, len(refs), REF_CHUNK):
            cond = " or ".join(f"Ref_Key eq guid'{r}'" for r in refs[i : i + REF_CHUNK])
            out.extend(self._rows(entity_set, **{"$filter": f"({cond})" + (f" and {extra}" if extra else "")}, **query))
        return out

    def _entity(self, entity_set: str, ref: str) -> dict:
        return self._get(f"{entity_set}(guid'{ref}')")

    def _patch(self, entity_set: str, ref: str, body: dict) -> dict:
        return self._request("PATCH", f"{entity_set}(guid'{ref}')", body=body)

    def _post_document(self, entity_set: str, ref: str) -> None:
        self._request("POST", f"{entity_set}(guid'{ref}')/Post", {"PostingModeOperational": "false"})

    def _unpost_document(self, entity_set: str, ref: str) -> None:
        self._request("POST", f"{entity_set}(guid'{ref}')/Unpost")

    @property
    def schema(self) -> Schema:
        if self._schema is None:
            response = self.http.get(self.url + "$metadata")
            if response.status_code >= 400:
                raise _odata_error(response, "$metadata")
            self._schema = Schema(response.text)
        return self._schema

    # --- reads ---------------------------------------------------------------------------------

    def cmd_ping(self) -> dict:
        orgs = self._organizations()
        org = orgs[0] if orgs else {}
        return {
            "version": "odata",
            "base_name": self.publication,
            "inn": org.get("inn"),
            "organization": org.get("name"),
            "platform": None,
            "closed_period_until": self._closed_until(),
        }

    def _organizations(self) -> list[dict]:
        rows = self._rows_or_empty(f"Catalog_{CATALOGS['organizations']}")
        return [
            {"ref": r["Ref_Key"], "name": r.get("Description", ""), "inn": str(r.get(A["inn"]) or "").strip()}
            for r in rows
            if not r.get("DeletionMark") and not r.get("IsFolder")
        ]

    def _closed_until(self) -> str | None:
        """Change-prohibition date for all users (БСП), if the base publishes that register."""
        try:
            rows = self._rows(f"InformationRegister_{CLOSING_DATES}")
        except ODataError:
            return None
        # The common date: set for all users and not for one object (section).
        dates = [
            no_date(r.get("ДатаЗапрета"))
            for r in rows
            if str(r.get("Пользователь", "")) == "ДляВсехПользователей" and not no_ref(r.get("Объект"))
        ]
        dates = [d for d in dates if d]
        return max(dates)[:10] if dates else None

    def cmd_get_catalog(self, name: str, changed_since: str | None = None, refs: list[str] | None = None) -> dict:
        if name not in CATALOGS:
            raise ODataError(404, "not_found", f"Unknown catalog {name}")
        entity_set = f"Catalog_{CATALOGS[name]}"
        query = {}
        if name == "items" and f"{A['unit']}_Key" in self.schema.props(self.schema.type_of(entity_set)):
            query["$expand"] = A["unit"]
        rows = self._by_refs(entity_set, refs, **query) if refs else self._rows_or_empty(entity_set, **query)
        items = []
        for r in rows:
            if r.get("IsFolder"):
                continue
            item = {"ref": r["Ref_Key"], "name": r.get("Description", ""), "deleted": bool(r.get("DeletionMark"))}
            if name in ("counterparties", "organizations"):
                item["inn"] = str(r.get(A["inn"]) or "").strip()
            elif name == "contracts":
                item["owner_ref"] = no_ref(r.get("Owner_Key"))
                item["number"] = str(r.get(A["contract_number"]) or "")
                item["date"] = (no_date(r.get(A["contract_date"])) or "")[:10] or None
            elif name == "items":
                unit = r.get(A["unit"])
                item["unit"] = unit.get("Description", "") if isinstance(unit, dict) else str(unit or "")
                item["price"] = r.get(A["price"]) or 0
                item["vat_rate"] = self._vat_number(r, A["vat_rate"])
                item["ikpu_code"] = str(r.get(A["ikpu"]) or "").strip()
            items.append(item)
        return {"name": name, "items": items}

    def cmd_get_documents(self, type: str, refs: list[str] | None = None, **period) -> dict:
        if type not in DOCUMENTS:
            raise ODataError(404, "not_found", f"Unknown document type {type}")
        entity_set = f"Document_{DOCUMENTS[type]}"
        if refs:
            rows = self._by_refs(entity_set, refs)
        else:
            cond = [f"Date ge {dt_literal(period['from'])}" if period.get("from") else None,
                    f"Date le {dt_literal(period['to'], True)}" if period.get("to") else None]
            rows = self._rows_or_empty(entity_set, **{"$filter": " and ".join(c for c in cond if c) or None, "$orderby": "Date"})
        return {"type": type, "items": [self._document(type, r) for r in rows]}

    def _document(self, type: str, r: dict) -> dict:
        warehouse = no_ref(r.get(f"{A['warehouse']}_Key"))
        included = r.get(A["vat_included"]) is True
        rows, vat = [], Decimal(0)
        for line in r.get(A["rows"]) or []:
            line_vat = num(line.get(A["row_vat"]))
            amount = num(line.get(A["row_amount"]))
            rows.append(
                {
                    "item_ref": no_ref(line.get(f"{A['item']}_Key")),
                    "quantity": line.get(A["quantity"]) or 0,
                    "price": line.get(A["row_price"]) or 0,
                    "amount": str(amount - line_vat if included else amount),  # always without VAT
                    "vat_rate": self._vat_number(line, A["row_vat_rate"]),
                    "vat_amount": str(line_vat),
                    "warehouse_ref": warehouse,
                }
            )
            vat += line_vat
        return {
            "ref": r["Ref_Key"],
            "type": type,
            "number": str(r.get("Number", "")).strip(),
            "date": no_date(r.get("Date")),
            "posted": bool(r.get("Posted")),
            "deleted": bool(r.get("DeletionMark")),
            "counterparty_ref": no_ref(r.get(f"{A['counterparty']}_Key")),
            "contract_ref": no_ref(r.get(f"{A['contract']}_Key")),
            "warehouse_ref": warehouse,
            "amount": r.get(A["total"]) or 0,
            "vat": str(vat),
            "rows": rows,
        }

    def _account_codes(self) -> dict[str, str]:
        if self._accounts is None:
            rows = self._rows(f"ChartOfAccounts_{LEDGER}", **{"$select": "Ref_Key,Code"})
            self._accounts = {r["Ref_Key"]: str(r.get("Code", "")).strip() for r in rows}
        return self._accounts

    def _subconto(self, r: dict, prefix: str, quantity: Any) -> dict:
        out: dict[str, Any] = {}
        for i in (1, 2, 3):
            value = r.get(f"{prefix}{i}")
            key = SUBCONTO.get(_short(r.get(f"{prefix}{i}_Type")))
            if key and no_ref(value):
                out[key] = value
        if quantity not in (None, 0, "0"):
            out["quantity"] = quantity
        return out

    def cmd_get_ledger(self, refs: list[str] | None = None, types: dict[str, str] | None = None, **period) -> dict:
        source = f"AccountingRegister_{LEDGER}/RecordsWithExtDimensions"
        if refs is None:
            start = dt_literal(period.get("from") or "0001-01-01")
            end = dt_literal(period.get("to") or self.today().isoformat(), True)
            rows = self._rows(f"{source}(StartPeriod={start},EndPeriod={end})", **{"$orderby": "Period"})
        else:
            rows = []
            by_type: dict[str, list[str]] = {}
            for r in refs:
                for t in [types[r]] if types and r in types else list(DOCUMENTS):
                    by_type.setdefault(t, []).append(r)
            for t, group in by_type.items():
                for i in range(0, len(group), REF_CHUNK):
                    cond = " or ".join(
                        f"Recorder eq cast(guid'{r}', 'Document_{DOCUMENTS[t]}')" for r in group[i : i + REF_CHUNK]
                    )
                    rows.extend(self._rows_or_empty(f"{source}()", **{"$filter": cond}))
        codes = self._account_codes()
        items = []
        for r in rows:
            items.append(
                {
                    "document_ref": r.get("Recorder"),
                    "date": no_date(r.get("Period")),
                    "dt": codes.get(r.get("AccountDr_Key"), ""),
                    "kt": codes.get(r.get("AccountCr_Key"), ""),
                    "amount": r.get("Сумма") or 0,
                    "subconto": {
                        "dt": self._subconto(r, "ExtDimensionDr", r.get("КоличествоDr")),
                        "kt": self._subconto(r, "ExtDimensionCr", r.get("КоличествоCr")),
                    },
                }
            )
        return {"items": items}

    def cmd_get_balances(self, date: str, account: str | None = None) -> dict:
        rows = self._rows(f"AccountingRegister_{LEDGER}/Balance(Period={dt_literal(date)})")
        codes = self._account_codes()
        items = []
        for r in rows:
            code = codes.get(r.get("Account_Key"), "")
            if account and not code.startswith(account):
                continue
            quantity = num(r.get("КоличествоBalanceDr")) - num(r.get("КоличествоBalanceCr"))
            items.append(
                {
                    "account": code,
                    "subconto": self._subconto(r, "ExtDimension", None),
                    "debit": r.get("СуммаBalanceDr") or 0,
                    "credit": r.get("СуммаBalanceCr") or 0,
                    "quantity": None if quantity == 0 else str(quantity),
                }
            )
        return {"date": date[:10], "items": items}

    def cmd_get_changes(self, since: str | None = None) -> dict:
        """Objects whose DataVersion changed since the snapshot taken at cursor `since`."""
        current: dict[str, list] = {}
        for api, name in CATALOGS.items():
            if api == "warehouses":
                continue
            for r in self._rows_or_empty(f"Catalog_{name}", **{"$select": "Ref_Key,DataVersion,DeletionMark"}):
                current[r["Ref_Key"]] = ["catalog", api, r.get("DataVersion"), bool(r.get("DeletionMark"))]
        for api, name in DOCUMENTS.items():
            for r in self._rows_or_empty(f"Document_{name}", **{"$select": "Ref_Key,DataVersion,DeletionMark"}):
                current[r["Ref_Key"]] = ["document", api, r.get("DataVersion"), bool(r.get("DeletionMark"))]
        cursor = uuid.uuid4().hex
        self.snapshots.save(cursor, current)
        if since is None:
            return {"cursor": cursor, "items": []}
        previous = self.snapshots.load(since)
        items = []
        for ref, (kind, name, version, deleted) in current.items():
            if previous is None or ref not in previous or previous[ref][2] != version:
                items.append({"kind": kind, "type" if kind == "document" else "name": name, "ref": ref, "deleted": deleted})
        for ref, (kind, name, _version, _deleted) in (previous or {}).items():
            if ref not in current:
                items.append({"kind": kind, "type" if kind == "document" else "name": name, "ref": ref, "deleted": True, "removed": True})
        return {"cursor": cursor, "items": items}

    def cmd_get_fix(self, id: str) -> None:
        return None  # the approval log is kept by the backend for direct connections

    # --- VAT rates (number, enum or catalog, depending on the release) --------------------------

    def _vat_catalog(self, catalog_type: str) -> dict[str, Decimal]:
        if catalog_type not in self._vat_refs:
            rows = self._rows(catalog_type)
            self._vat_refs[catalog_type] = {r["Ref_Key"]: num(r.get("Ставка")) for r in rows}
        return self._vat_refs[catalog_type]

    def _vat_number(self, row: dict, attr: str) -> Any:
        if f"{attr}_Key" in row:
            ref = no_ref(row[f"{attr}_Key"])
            if not ref:
                return None
            for rates in self._vat_refs.values():
                if ref in rates:
                    return rates[ref]
            target = self._vat_target()
            return self._vat_catalog(target).get(ref) if target else None
        value = row.get(attr)
        if value in (None, ""):
            return None
        if isinstance(value, (int, float, Decimal)):
            return value
        digits = "".join(ch for ch in str(value) if ch.isdigit())
        return int(digits) if digits else 0

    def _vat_target(self) -> str | None:
        for type_name in self.schema.types:
            target = self.schema.ref_target(type_name, A["vat_rate"])
            if target:
                return target
        return None

    def _vat_field(self, type_name: str, attr: str, rate: Any) -> dict:
        """Body fragment that sets a VAT rate attribute of `type_name` to `rate` percent."""
        rate = num(rate)
        props = self.schema.props(type_name)
        if f"{attr}_Key" in props:
            target = self.schema.ref_target(type_name, attr) or self._vat_target()
            for ref, value in self._vat_catalog(target).items():
                if value == rate:
                    return {f"{attr}_Key": ref}
            raise ODataError(400, "bad_vat_rate", f"No VAT rate {rate}% in {target}")
        if props.get(attr) in NUMERIC:
            return {attr: float(rate)}
        members = self.schema.enum_like("СтавкиНДС")
        exact = f"НДС{int(rate)}"
        if not members or exact in members:
            return {attr: exact}
        for member in members:
            digits = "".join(ch for ch in member if ch.isdigit())
            if num(digits or 0) == rate:
                return {attr: member}
        raise ODataError(400, "bad_vat_rate", f"No VAT rate {rate}%")

    # --- writes: invoices and fixes ---------------------------------------------------------------

    def _check_period(self, when: str | None) -> None:
        closed = self._closed_until()
        if closed and when and str(when)[:10] <= closed:
            raise ODataError(409, "closed_period", "Period is closed (change-prohibition date)")

    def _doc(self, obj: dict) -> tuple[str, dict]:
        entity_set = f"Document_{DOCUMENTS[obj['type']]}"
        row = self._entity(entity_set, obj["ref"])
        self._check_period(row.get("Date"))
        return entity_set, row

    def _repost_if_posted(self, entity_set: str, row: dict) -> None:
        if row.get("Posted"):
            self._post_document(entity_set, row["Ref_Key"])

    def cmd_create_invoice(self, approval_id: str, date: str, buyer_ref: str, contract_ref: str, rows: list[dict], **extra) -> dict:
        entity_set = f"Document_{DOCUMENTS['invoice_out']}"
        type_name = self.schema.type_of(entity_set)
        props = self.schema.props(type_name)
        row_type = self.schema.row_type(type_name, A["rows"]) or ""
        self._check_period(date)
        lines, total, vat = [], Decimal(0), Decimal(0)
        for i, r in enumerate(rows, start=1):
            line = {
                "LineNumber": i,
                f"{A['item']}_Key": r["item_ref"],
                A["quantity"]: float(num(r["quantity"])),
                A["row_price"]: float(num(r["price"])),
                A["row_amount"]: float(num(r["amount"])),
                A["row_vat"]: float(num(r["vat"])),
                **self._vat_field(row_type, A["row_vat_rate"], r["vat_rate"]),
            }
            lines.append(line)
            total += num(r["amount"]) + num(r["vat"])
            vat += num(r["vat"])
        body = {
            "Date": f"{date[:10]}T12:00:00",
            f"{A['counterparty']}_Key": buyer_ref,
            f"{A['contract']}_Key": contract_ref,
            A["rows"]: lines,
        }
        orgs = self._organizations()
        if orgs and f"{A['organization']}_Key" in props:
            body[f"{A['organization']}_Key"] = orgs[0]["ref"]
        if A["vat_included"] in props:
            body[A["vat_included"]] = False  # row amounts come without VAT
        if A["total"] in props:
            body[A["total"]] = float(total)
        if A["comment"] in props:
            body[A["comment"]] = f"Создан из веб-приложения, счёт №{extra.get('app_invoice_id', '')}"
        created = self._request("POST", entity_set, body=body)
        return {
            "ref": created["Ref_Key"],
            "number": str(created.get("Number", "")).strip(),
            "date": no_date(created.get("Date")),
            "total": str(total),
            "vat": str(vat),
            "posted": False,
        }

    def cmd_post_invoice(self, approval_id: str, ref: str, **extra) -> dict:
        entity_set, _row = self._doc({"type": "invoice_out", "ref": ref})
        self._post_document(entity_set, ref)
        return {"ref": ref, "posted": True}

    def cmd_apply_fix(self, type: str, object: dict, changes: dict, fix_id: int | None = None, reverse_of: str | None = None, **extra) -> dict:
        if type == "restore":
            before, after = self._restore(reverse_of, object, changes)
        elif type == "fill_field":
            before, after = self._fill_field(object, changes["field"], changes.get("value"))
        elif type == "repost":
            entity_set, row = self._doc(object)
            self._post_document(entity_set, object["ref"])
            before, after = {"posted": bool(row.get("Posted"))}, {"posted": True}
        elif type == "correct_vat":
            before, after = self._correct_vat(object, changes["rows"])
        elif type == "reverse_duplicate":
            entity_set, row = self._doc(object)
            if row.get("Posted"):
                self._unpost_document(entity_set, object["ref"])
            self._patch(entity_set, object["ref"], {"DeletionMark": True})
            before = {"posted": bool(row.get("Posted")), "deletion_mark": bool(row.get("DeletionMark"))}
            after = {"posted": False, "deletion_mark": True}
        elif type == "merge_counterparties":
            before, after = self._merge(object["ref"], changes["main_ref"], changes.get("documents") or [])
        else:
            raise ODataError(400, "unknown_fix", f"Unknown fix type {type}")
        return {"fix_id": fix_id, "before": before, "after": after}

    def _fill_field(self, obj: dict, field: str, value: Any) -> tuple[dict, dict]:
        kind = obj["kind"]
        if kind == "document" and field == "contract_ref":
            entity_set, row = self._doc(obj)
            attr = f"{A['contract']}_Key"
            before = no_ref(row.get(attr))
            self._patch(entity_set, obj["ref"], {attr: value or ZERO_GUID})
            self._repost_if_posted(entity_set, row)
            return {"field": field, "value": before}, {"field": field, "value": value or None}
        if kind == "counterparty" and field == "inn":
            entity_set, attr = f"Catalog_{CATALOGS['counterparties']}", A["inn"]
        elif kind == "item" and field == "ikpu_code":
            entity_set, attr = f"Catalog_{CATALOGS['items']}", A["ikpu"]
        elif kind == "item" and field == "vat_rate":
            entity_set = f"Catalog_{CATALOGS['items']}"
            row = self._entity(entity_set, obj["ref"])
            before = self._vat_number(row, A["vat_rate"])
            if value in (None, ""):
                body = {f"{A['vat_rate']}_Key": ZERO_GUID} if f"{A['vat_rate']}_Key" in row else {A["vat_rate"]: ""}
            else:
                body = self._vat_field(self.schema.type_of(entity_set), A["vat_rate"], value)
            self._patch(entity_set, obj["ref"], body)
            return {"field": field, "value": None if before is None else str(before)}, {"field": field, "value": value}
        else:
            raise ODataError(400, "bad_field", f"Field {field} cannot be filled on {kind}")
        row = self._entity(entity_set, obj["ref"])
        before = row.get(attr)
        self._patch(entity_set, obj["ref"], {attr: "" if value is None else str(value)})
        return {"field": field, "value": before or None}, {"field": field, "value": value}

    def _correct_vat(self, obj: dict, fixes: list[dict]) -> tuple[dict, dict]:
        entity_set, row = self._doc(obj)
        type_name = self.schema.type_of(entity_set)
        row_type = self.schema.row_type(type_name, A["rows"]) or ""
        included = row.get(A["vat_included"]) is True
        lines = [_writable(line) for line in row.get(A["rows"]) or []]
        was, now = [], []
        for fix in fixes:
            n = int(fix["row"])
            if n < 1 or n > len(lines):
                raise ODataError(400, "bad_row", f"No row {n}")
            line = lines[n - 1]
            rate = num(fix["vat_rate"])
            was.append({"row": n, "vat_rate": self._vat_number(line, A["row_vat_rate"])})
            line.pop(f"{A['row_vat_rate']}_Key", None)
            line.update(self._vat_field(row_type, A["row_vat_rate"], rate))
            amount = num(line.get(A["row_amount"]))
            vat = amount * rate / (100 + rate) if included else amount * rate / 100
            line[A["row_vat"]] = float(vat.quantize(Decimal("0.01")))
            now.append({"row": n, "vat_rate": fix["vat_rate"]})
        self._patch(entity_set, obj["ref"], {A["rows"]: lines})
        self._repost_if_posted(entity_set, row)
        return {"rows": was}, {"rows": now}

    def _merge(self, duplicate: str, main: str, documents: list[dict]) -> tuple[dict, dict]:
        """Not one transaction over OData: contracts, then documents, then the deletion mark."""
        counterparties = f"Catalog_{CATALOGS['counterparties']}"
        self._entity(counterparties, duplicate)
        self._entity(counterparties, main)
        for d in documents:
            self._doc(d)  # check every period before changing anything
        contracts_set = f"Catalog_{CATALOGS['contracts']}"
        contracts = []
        for c in self._rows(contracts_set, **{"$filter": f"Owner_Key eq guid'{duplicate}'", "$select": "Ref_Key"}):
            self._patch(contracts_set, c["Ref_Key"], {"Owner_Key": main})
            contracts.append(c["Ref_Key"])
        moved = []
        for d in documents:
            entity_set, row = self._doc(d)
            self._patch(entity_set, d["ref"], {f"{A['counterparty']}_Key": main})
            self._repost_if_posted(entity_set, row)
            moved.append({"type": d["type"], "ref": d["ref"]})
        self._patch(counterparties, duplicate, {"DeletionMark": True})
        before = {"counterparty_ref": duplicate, "documents": moved, "contracts": contracts, "deletion_mark": False}
        after = {"counterparty_ref": main, "documents": moved, "contracts": contracts, "deletion_mark": True}
        return before, after

    def _restore(self, original: str | None, obj: dict, changes: dict) -> tuple[dict, dict]:
        snapshot = changes["restore"]
        if original == "fill_field":
            return self._fill_field(obj, snapshot["field"], snapshot.get("value"))
        if original == "correct_vat":
            return self._correct_vat(obj, snapshot["rows"])
        if original == "reverse_duplicate":
            entity_set, row = self._doc(obj)
            self._patch(entity_set, obj["ref"], {"DeletionMark": snapshot.get("deletion_mark") is True})
            if snapshot.get("posted") is True:
                self._post_document(entity_set, obj["ref"])
            return {"posted": bool(row.get("Posted")), "deletion_mark": bool(row.get("DeletionMark"))}, snapshot
        if original == "merge_counterparties":
            duplicate = snapshot["counterparty_ref"]
            for d in snapshot.get("documents") or []:
                self._doc(d)
            for ref in snapshot.get("contracts") or []:
                self._patch(f"Catalog_{CATALOGS['contracts']}", ref, {"Owner_Key": duplicate})
            for d in snapshot.get("documents") or []:
                entity_set, row = self._doc(d)
                self._patch(entity_set, d["ref"], {f"{A['counterparty']}_Key": duplicate})
                self._repost_if_posted(entity_set, row)
            self._patch(f"Catalog_{CATALOGS['counterparties']}", duplicate, {"DeletionMark": False})
            return {"deletion_mark": True}, snapshot
        if original == "repost":
            return {}, snapshot
        raise ODataError(400, "unknown_fix", f"Cannot undo {original}")

    # --- generic object API ------------------------------------------------------------------------

    def _set_name(self, kind: str, name: str) -> str:
        if kind not in PREFIX:
            raise ODataError(400, "bad_kind", f"{kind} is not available over a direct connection")
        return f"{PREFIX[kind]}_{name}"

    def cmd_get_metadata(self) -> dict:
        schema = self.schema
        groups: dict[str, list] = {
            "catalogs": [], "documents": [], "information_registers": [], "accumulation_registers": [],
            "accounting_registers": [], "charts_of_accounts": [], "charts_of_characteristic_types": [],
        }
        group_of = {
            "Catalog": "catalogs", "Document": "documents", "InformationRegister": "information_registers",
            "AccumulationRegister": "accumulation_registers", "AccountingRegister": "accounting_registers",
            "ChartOfAccounts": "charts_of_accounts", "ChartOfCharacteristicTypes": "charts_of_characteristic_types",
        }
        for entity_set, type_name in sorted(schema.sets.items()):
            prefix, _, name = entity_set.partition("_")
            if prefix not in group_of or type_name.endswith("_RowType") or not name:
                continue
            props = schema.props(type_name)
            entry: dict[str, Any] = {
                "name": name,
                "synonym": name,
                "attributes": [
                    {"name": p[:-4] if p.endswith("_Key") else p, "types": [_attr_type(schema, type_name, p, t)]}
                    for p, t in props.items()
                    if p not in SYSTEM and p not in STANDARD and not p.endswith("_Type") and not (t or "").startswith("Collection(")
                ],
            }
            if prefix in ("Catalog", "Document", "ChartOfAccounts", "ChartOfCharacteristicTypes"):
                entry["standard"] = [STANDARD[p] for p in props if p in STANDARD]
                entry["writable"] = prefix in ("Catalog", "Document")
                entry["tabular_sections"] = [
                    {"name": t, "attributes": [{"name": p[:-4] if p.endswith("_Key") else p} for p in schema.props(schema.row_type(type_name, t) or "") if p not in SYSTEM and not p.endswith("_Type")]}
                    for t in schema.tables(type_name)
                ]
            if prefix == "Document":
                entry["posting"] = "Posted" in props
            groups[group_of[prefix]].append(entry)
        enums = [{"name": n.split("_", 1)[-1], "values": [{"name": m} for m in members]} for n, members in schema.enums.items()]
        return {"configuration": None, "version": None, "base_name": self.publication, "connection": "odata", **groups, "enums": enums}

    def _describe(self, kind: str, name: str, row: dict) -> dict:
        type_name = self.schema.type_of(self._set_name(kind, name))
        standard, attributes, tables = {}, {}, {}
        for key, value in row.items():
            if "@" in key or key in SYSTEM or key.endswith("_Type"):
                continue
            if key in STANDARD:
                standard[STANDARD[key]] = self._value(type_name, key, value, row)
            elif isinstance(value, list):
                row_type = self.schema.row_type(type_name, key) or ""
                tables[key] = [
                    {
                        (k[:-4] if k.endswith("_Key") else k): self._value(row_type, k, v, line)
                        for k, v in line.items()
                        if "@" not in k and k not in ("Ref_Key", "LineNumber") and not k.endswith("_Type")
                    }
                    for line in value
                ]
            elif not isinstance(value, dict):
                attributes[key[:-4] if key.endswith("_Key") else key] = self._value(type_name, key, value, row)
        presentation = row.get("Description") or " ".join(
            x for x in (str(row.get("Number", "")).strip(), (no_date(row.get("Date")) or "")[:10]) if x
        )
        out = {
            "_type": ru_type(type_name) or f"{RU_CLASS.get(PREFIX[kind], kind)}.{name}",
            "ref": row.get("Ref_Key"),
            "presentation": presentation,
            "deletion_mark": bool(row.get("DeletionMark")),
            "standard": standard,
            "attributes": attributes,
            "tables": tables,
        }
        if kind == "document":
            out["posted"] = bool(row.get("Posted"))
        return out

    def _value(self, type_name: str, key: str, value: Any, row: dict) -> Any:
        """An OData value in the extension's JSON format (references as {_type, ref})."""
        if key.endswith("_Key"):
            ref = no_ref(value)
            if not ref:
                return None
            target = self.schema.ref_target(type_name, key[:-4]) if type_name else None
            if key == "Parent_Key" and not target:
                target = type_name
            return {"_type": ru_type(target), "ref": ref}
        composite = row.get(f"{key}_Type")
        if composite and is_ref(value):
            return {"_type": ru_type(composite), "ref": value} if no_ref(value) else None
        if isinstance(value, str) and value.startswith("0001-01-01T"):
            return None
        return value

    def cmd_list_objects(self, kind: str, name: str, refs: list[str] | None = None, filter: dict | None = None,
                         limit: int = 100, offset: int = 0, include_deleted: bool = False, **period) -> dict:
        if kind == "enum":
            members = self.schema.enums.get(f"Enum_{name}")
            if members is None:
                raise ODataError(404, "not_found", f"Enum {name} is not published")
            items = [{"_type": f"Перечисление.{name}", "value": m, "presentation": m} for m in members]
            return {"kind": kind, "name": name, "total": len(items), "items": items}
        entity_set = self._set_name(kind, name)
        type_name = self.schema.type_of(entity_set)
        props = self.schema.props(type_name)
        cond = []
        object_kind = kind in ("catalog", "document", "chart_of_accounts", "chart_of_characteristic_types")
        if object_kind and not include_deleted:
            cond.append("DeletionMark eq false")
        if refs:
            cond.append("(" + " or ".join(f"Ref_Key eq guid'{r}'" for r in refs) + ")")
        date_field = "Date" if kind == "document" else ("Period" if "Period" in props else None)
        if date_field and period.get("from"):
            cond.append(f"{date_field} ge {dt_literal(period['from'])}")
        if date_field and period.get("to"):
            cond.append(f"{date_field} le {dt_literal(period['to'], True)}")
        for key, value in (filter or {}).items():
            cond.append(self._filter(type_name, props, key, value))
        query = {"$filter": " and ".join(cond) or None, "$top": int(limit), "$skip": int(offset) or None, "$inlinecount": "allpages"}
        if date_field:
            query["$orderby"] = date_field
        data = self._get(entity_set, **query)
        rows = data.get("value", [])
        total = int(data.get("odata.count") or (len(rows) + int(offset)))
        if object_kind:
            items = [self._describe(kind, name, r) for r in rows]
        else:
            items = [{k: self._value(type_name, k, v, r) for k, v in r.items() if "@" not in k and not k.endswith("_Type")} for r in rows]
        return {"kind": kind, "name": name, "total": total, "items": items}

    def _filter(self, type_name: str, props: dict, key: str, value: Any) -> str:
        field = STANDARD_BACK.get(key, key)
        if f"{field}_Key" in props:
            field += "_Key"
        if field not in props:
            raise ODataError(400, "bad_filter", f"{type_name} has no field {key}")
        if isinstance(value, dict):
            return f"{field} eq guid'{value.get('ref')}'" if value.get("ref") else f"{field} eq '{value.get('value', '')}'"
        if value is None:
            return f"{field} eq guid'{ZERO_GUID}'" if field.endswith("_Key") else f"{field} eq ''"
        if isinstance(value, bool):
            return f"{field} eq {'true' if value else 'false'}"
        if isinstance(value, (int, float)):
            return f"{field} eq {value}"
        if field.endswith("_Key"):
            return f"{field} eq guid'{value}'"
        if props[field] == "Edm.DateTime":
            return f"{field} eq {dt_literal(str(value))}"
        return f"{field} eq '" + str(value).replace("'", "''") + "'"

    def cmd_get_object(self, kind: str, name: str, ref: str) -> dict:
        return self._describe(kind, name, self._entity(self._set_name(kind, name), ref))

    def cmd_run_query(self, text: str, params: dict | None = None, limit: int | None = None) -> dict:
        raise ODataError(
            501,
            "not_available",
            "1C queries need the AIAPI extension; a direct (OData) connection supports lists, filters and objects only",
        )

    def _to_odata(self, type_name: str, data: dict | None, *, creating: bool = False) -> dict:
        """The extension's {standard, attributes, tables} -> an OData body."""
        props = self.schema.props(type_name)
        body: dict[str, Any] = {}
        for key, value in ((data or {}).get("standard") or {}).items():
            if key == "ЭтоГруппа" and not creating:
                continue
            field = STANDARD_BACK.get(key)
            if field is None or (props and field not in props):
                raise ODataError(400, "bad_attribute", f"{type_name} has no standard attribute {key}")
            if field.endswith("_Key"):
                body[field] = (value or {}).get("ref") or ZERO_GUID if isinstance(value, dict) or value is None else value
            elif field == "Date":
                body[field] = str(value)[:19] if len(str(value)) > 10 else f"{value}T00:00:00"
            else:
                body[field] = value
        for key, value in ((data or {}).get("attributes") or {}).items():
            body.update(self._field(type_name, props, key, value))
        for table, lines in ((data or {}).get("tables") or {}).items():
            if props and table not in self.schema.tables(type_name):
                raise ODataError(400, "bad_attribute", f"{type_name} has no tabular section {table}")
            row_type = self.schema.row_type(type_name, table) or ""
            row_props = self.schema.props(row_type)
            out = []
            for i, line in enumerate(lines, start=1):
                row = {"LineNumber": i}
                for k, v in line.items():
                    if k == "НомерСтроки":
                        continue
                    row.update(self._field(row_type, row_props, k, v))
                out.append(row)
            body[table] = out
        return body

    def _field(self, type_name: str, props: dict, key: str, value: Any) -> dict:
        if f"{key}_Key" in props:
            ref = value.get("ref") if isinstance(value, dict) else value
            return {f"{key}_Key": ref or ZERO_GUID}
        if props and key not in props:
            raise ODataError(400, "bad_attribute", f"{type_name} has no attribute {key}")
        if f"{key}_Type" in props and isinstance(value, dict) and value.get("ref"):
            return {key: value["ref"], f"{key}_Type": odata_type(value["_type"])}
        if isinstance(value, dict):
            return {key: value.get("value", value.get("ref"))}
        return {key: value}

    def cmd_write_object(self, kind: str, name: str, action: str, ref: str | None = None, data: dict | None = None,
                         post: bool | None = None, snapshot: dict | None = None, fix_id: int | None = None, **extra) -> dict:
        if kind not in ("catalog", "document"):
            raise ODataError(400, "not_writable", "Only catalogs and documents can be changed")
        entity_set = self._set_name(kind, name)
        type_name = self.schema.type_of(entity_set)
        is_doc = kind == "document"
        before = None
        if action == "create":
            body = self._to_odata(type_name, data, creating=True)
            if is_doc and "Date" not in body:
                body["Date"] = datetime.now().replace(microsecond=0).isoformat()
            if is_doc:
                self._check_period(body["Date"])
            ref = self._request("POST", entity_set, body=body)["Ref_Key"]
            if is_doc and post:
                self._post_document(entity_set, ref)
        else:
            if not ref:
                raise ODataError(400, "bad_params", "ref is required")
            row = self._entity(entity_set, ref)
            if is_doc:
                self._check_period(row.get("Date"))
            before = self._describe(kind, name, row)
            posted = bool(row.get("Posted"))
            if action == "update":
                body = self._to_odata(type_name, data)
                if is_doc and body.get("Date"):
                    self._check_period(body["Date"])
                self._patch(entity_set, ref, body)
                if is_doc and (post or posted):
                    self._post_document(entity_set, ref)
            elif action == "restore":
                if not isinstance(snapshot, dict):
                    raise ODataError(400, "bad_request", "restore needs a snapshot")
                mark = snapshot.get("deletion_mark") is True
                target_posted = is_doc and snapshot.get("posted") is True and not mark
                if is_doc and posted and not target_posted:
                    self._unpost_document(entity_set, ref)
                body = self._to_odata(type_name, {k: snapshot[k] for k in ("standard", "attributes", "tables") if snapshot.get(k)})
                body["DeletionMark"] = mark
                self._patch(entity_set, ref, body)
                if target_posted:
                    self._post_document(entity_set, ref)
            elif action in ("post", "unpost"):
                if not is_doc:
                    raise ODataError(400, "bad_action", f"{action} applies to documents only")
                (self._post_document if action == "post" else self._unpost_document)(entity_set, ref)
            elif action == "mark_deletion":
                if is_doc and posted:
                    self._unpost_document(entity_set, ref)
                self._patch(entity_set, ref, {"DeletionMark": True})
            elif action == "unmark_deletion":
                self._patch(entity_set, ref, {"DeletionMark": False})
            else:
                raise ODataError(400, "bad_action", f"Unknown action {action}")
        after = self._describe(kind, name, self._entity(entity_set, ref))
        return {"fix_id": fix_id, "ref": ref, "before": before, "after": after}


# --- connection test (the "Connect 1C" form) --------------------------------------------------------


def test_connection(url: str, username: str, password: str, transport: httpx.BaseTransport | None = None) -> dict:
    """Try the address and credentials; report the organizations and what the base publishes."""
    conn = ODataOneC(url, username, password, transport=transport, timeout=15)
    result: dict[str, Any] = {"url": url, "ok": False, "organizations": [], "found": [], "missing": []}
    try:
        schema = conn.schema
        result["found"] = [s for s in REQUIRED_SETS if s in schema.sets]
        result["missing"] = [s for s in REQUIRED_SETS if s not in schema.sets]
        result["published"] = len(schema.sets)
        result["organizations"] = conn._organizations() if f"Catalog_{CATALOGS['organizations']}" in schema.sets else []
        result["ok"] = True
    except ODataError as e:
        result["error"] = _explain(e)
    except httpx.TransportError as e:
        result["error"] = f"Cannot reach {urlsplit(url).netloc}. Check the address, that the computer with 1C is on and in the same network, and the firewall. ({e})"
    except ET.ParseError:
        result["error"] = "The address answers, but not with 1C OData. Check the base name."
    finally:
        conn.close()
    return result


def _explain(e: ODataError) -> str:
    if e.status == 401:
        return "1C rejected the username or password."
    if e.status == 403:
        return "This 1C user has no right to use the OData interface."
    if e.status == 404:
        return (
            "No 1C OData at this address. Check the base (publication) name, and that the base is published "
            "with «Публиковать стандартный интерфейс OData» ticked."
        )
    return e.message


# --- helpers --------------------------------------------------------------------------------------


def _error(status: int, code: str, message: str) -> dict:
    return {"ok": False, "status": status, "error": {"error": code, "message": message, "details": {}}}


def _odata_error(response: httpx.Response, path: str) -> ODataError:
    message = ""
    try:
        err = response.json().get("odata.error") or {}
        message = (err.get("message") or {}).get("value") or err.get("code") or ""
    except ValueError:
        message = response.text[:300]
    status = response.status_code
    lowered = message.lower()
    if "запрет" in lowered and "дат" in lowered:
        return ODataError(409, "closed_period", message)
    if status == 404:
        return ODataError(404, "not_found", message or f"{path} is not published in the OData interface")
    if status == 401:
        return ODataError(401, "unauthorized", "1C rejected the username or password")
    return ODataError(status if status < 500 else 502, "onec_error", message or f"1C answered {status}")


def _writable(line: dict) -> dict:
    return {k: v for k, v in line.items() if "@" not in k and k != "Ref_Key"}


def _attr_type(schema: Schema, type_name: str, prop: str, odata_type_name: str | None) -> str:
    if prop.endswith("_Key"):
        return ru_type(schema.ref_target(type_name, prop[:-4])) or "Ссылка"
    return {"Edm.String": "Строка", "Edm.Boolean": "Булево", "Edm.DateTime": "Дата"}.get(
        odata_type_name or "", "Число" if odata_type_name in NUMERIC else (odata_type_name or "")
    )
