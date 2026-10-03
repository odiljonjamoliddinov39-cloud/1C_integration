# API contract

Two interfaces cross machine boundaries:

1. **1C extension HTTP service:** `aiapi` at `/hs/aiapi/v1/`, called only by the agent on `127.0.0.1`.
2. **Agent ↔ backend WebSocket:** `wss://<domain>/agent`, opened outbound by the agent.

The browser API (`/api/...`) is documented automatically by FastAPI at `/api/docs`.

---

## 1. Extension HTTP service (`/hs/aiapi/v1/`)

* Auth: `Authorization: Bearer <ТокенAIAPI>` on every request. Missing or wrong token: `401`.
* JSON, UTF-8. Dates are ISO 8601 (`2026-09-05T10:00:00`). Amounts are numbers in UZS.
  References are the 1C UUID as a string.
* Errors: `{"error": "code", "message": "text", "details": {}}` with HTTP `400`, `401`, `404`,
  `409` (closed period) or `500`.
* `refs` parameters are comma-separated UUIDs. The agent sends at most 50 per request.

### Document types

| API type | 1C document (default name, see `AIAPI_Метаданные`) |
|---|---|
| `sale` | РеализацияТоваровУслуг |
| `purchase` | ПоступлениеТоваровУслуг |
| `invoice_out` | СчетФактураВыданный |
| `invoice_in` | СчетФактураПолученный |
| `cash_in` | ПриходныйКассовыйОрдер |
| `cash_out` | РасходныйКассовыйОрдер |
| `bank_in` | ПоступлениеНаРасчетныйСчет |
| `bank_out` | СписаниеСРасчетногоСчета |
| `operation` | ОперацияБух (manual entries) |

### `GET /ping` (all functions)

```json
{"version": "1.0.0", "base_name": "TEST_CRYSTAL", "inn": "300000001", "organization": "CRYCTAL WATER TREDE MCHJ",
 "platform": "8.3.24.1342", "configuration": "Бухгалтерия для Узбекистана 3.0.x", "closed_period_until": "2026-06-30"}
```

### `GET /catalogs/{name}?changed_since=&refs=` (B, D)

`name` ∈ `counterparties`, `contracts`, `items`, `warehouses`, `organizations`.
`changed_since` is a cursor from `/changes`.

```json
{"name": "counterparties", "items": [{"ref": "…", "name": "ООО Покупатель", "inn": "123456789", "deleted": false}]}
{"name": "contracts", "items": [{"ref": "…", "owner_ref": "…", "name": "Договор №15", "number": "15", "date": "2025-01-01", "deleted": false}]}
{"name": "items", "items": [{"ref": "…", "name": "Вода 19л", "unit": "шт", "price": 10000, "vat_rate": 12, "ikpu_code": "10202001001000000", "deleted": false}]}
```

### `GET /documents/{type}?from=&to=` or `?refs=` (B, D)

```json
{"type": "sale", "items": [{
  "ref": "…", "type": "sale", "number": "000041", "date": "2026-09-25T10:00:00", "posted": true, "deleted": false,
  "counterparty_ref": "…", "contract_ref": "…", "warehouse_ref": "…", "amount": 56000, "vat": 6000,
  "rows": [{"item_ref": "…", "quantity": 100, "price": 500, "amount": 50000, "vat_rate": 12, "vat_amount": 6000, "warehouse_ref": "…"}]
}]}
```

`amount` is the document total including VAT. Row `amount` is always without VAT.

### `GET /ledger?from=&to=` or `?refs=` (B, D)

Journal entries (Хозрасчетный). With `refs`, it returns the entries of those registrars.

```json
{"items": [{"document_ref": "…", "date": "2026-09-05T10:00:00", "dt": "4010", "kt": "9010", "amount": 200000,
            "subconto": {"dt": {"counterparty_ref": "…", "contract_ref": "…"}, "kt": {}}}]}
```

Subconto keys: `counterparty_ref`, `contract_ref`, `item_ref`, `warehouse_ref`, `quantity`.

### `GET /balances?date=&account=` (B, D)

Balances at the **start** of `date` (movements of that day excluded), per account and subconto.

```json
{"date": "2025-01-01", "items": [{"account": "5010", "subconto": {}, "debit": 1000000, "credit": 0, "quantity": null}]}
```

### `GET /changes?since=` (E)

`since` is an opaque cursor (UTC milliseconds). Without `since`, it returns the current cursor
and no items. Items overlap the previous call by 2 minutes, because a long transaction can commit
after its timestamp. Re-reading an object is harmless.

```json
{"cursor": "1790000000000", "items": [
  {"kind": "document", "type": "sale", "ref": "…", "deleted": false, "removed": false},
  {"kind": "catalog", "name": "counterparties", "ref": "…", "deleted": false, "removed": false}]}
```

`deleted` = deletion mark, `removed` = deleted physically.

### Write endpoints

Rules for every write:

* `approval_id` (UUID issued by the backend after a person approves) is required → else `400 approval_required`.
* A repeated `approval_id` returns the stored result and changes nothing.
* Runs inside one 1C transaction; any error rolls back the whole change.
* Writes a `ЖурналИзмененийAI` record: who (`approved_by`), when, object, before, after.
* Refuses to touch a closed period (date on or before the change-prohibition date): `409 closed_period`.

#### `POST /invoices` (A): create an unposted Счет-фактура выданный

```json
{"approval_id": "…", "approved_by": "acc@example.com", "app_invoice_id": 12, "date": "2026-10-02",
 "buyer_ref": "…", "contract_ref": "…", "total": "33600.00", "vat": "3600.00",
 "rows": [{"item_ref": "…", "quantity": "3", "price": "10000", "vat_rate": "12", "amount": "30000.00", "vat": "3600.00"}]}
```
→ `{"ref": "…", "number": "000045", "date": "…", "total": 33600, "vat": 3600, "posted": false}`

#### `POST /invoices/{id}/post` (A)

`{"approval_id": "…", "approved_by": "…"}` → `{"ref": "…", "posted": true}`

#### `POST /fixes` (C)

```json
{"approval_id": "…", "approved_by": "…", "fix_id": 7, "type": "correct_vat",
 "object": {"kind": "document", "type": "sale", "ref": "…"},
 "changes": {"rows": [{"row": 1, "item_ref": "…", "vat_rate": 12}], "repost": true}}
```
→ `{"fix_id": 7, "before": {...}, "after": {...}}`

| `type` | `object.kind` | `changes` | What 1C does |
|---|---|---|---|
| `fill_field` | counterparty / item / document | `{"field": "inn" \| "ikpu_code" \| "vat_rate" \| "contract_ref", "value": …}` | Sets one empty attribute; re-posts a posted document |
| `repost` | document | `{}` | Re-posts the document |
| `correct_vat` | document | `{"rows": [{"row", "vat_rate"}]}` | Sets row VAT rates, recalculates row VAT, re-posts |
| `reverse_duplicate` | document | `{"unpost": true, "deletion_mark": true}` | Unposts and marks for deletion |
| `merge_counterparties` | counterparty (the duplicate) | `{"main_ref", "documents": [{"type", "ref"}], "deletion_mark": true}` | Moves the duplicate's contracts and documents to the main counterparty, marks the duplicate |
| `restore` (undo) | as the original | `{…original changes, "restore": <before of the original fix>}` + top-level `reverse_of` | Puts the `before` values back |

#### `GET /fixes/{id}` (C)

`id` is the `approval_id`. Returns the stored result (`{"fix_id", "before", "after"}`), or `404`.

### Direct API: any object of the base

These endpoints reach the whole base, not only the mirrored catalogs and documents.

`kind` is one of `catalog`, `document`, `information_register`, `accumulation_register`,
`accounting_register`, `chart_of_accounts`, `chart_of_characteristic_types` or `enum`. `name` is the
1C metadata name (`Контрагенты`, `РеализацияТоваровУслуг`, `Хозрасчетный`, ...), URL-encoded.
Only `catalog` and `document` can be written.

Values in JSON:

| 1C value | JSON |
|---|---|
| string, number, boolean | as is |
| date | `"2026-09-30T12:00:00"` |
| empty reference | `null` |
| reference | `{"_type": "Справочник.Контрагенты", "ref": "<uuid>", "presentation": "ООО Покупатель"}` |
| account | the same plus `"code": "4010"` (on write, `{"_type": "ПланСчетов.Хозрасчетный", "code": "4010"}` is enough) |
| enum value | `{"_type": "Перечисление.СтавкиНДС", "value": "НДС12", "presentation": "12%"}` |

#### `GET /metadata`

The configuration's content: `catalogs`, `documents`, `information_registers`,
`accumulation_registers`, `accounting_registers`, `charts_of_accounts`,
`charts_of_characteristic_types` and `enums`. Each entry has `name`, `synonym` and its fields with
types: `attributes`, `standard`, `tabular_sections`, plus `posting` and `writable` for documents,
`dimensions`, `resources` and `period_field` for registers, and `values` for enums. Also
`configuration`, `version` and `base_name`.

#### `GET /objects/{kind}/{name}?refs=&from=&to=&filter=&limit=&offset=&include_deleted=`

* `filter`: a JSON object of field → value, for example `{"ИНН": "123456789"}`. Field names are checked
  against the metadata.
* `from` and `to` filter on `Дата` for documents and `Период` for registers.
* `limit` defaults to 100 (maximum 5000). Objects marked for deletion are left out unless
  `include_deleted=true`.

→ `{"kind", "name", "total", "items": [...]}`. Catalog, document and chart items are full objects
(see below). Register items are rows of the register table (`{"Период": …, "Регистратор": …, …}`).
Enum items are the enum values.

#### `GET /objects/{kind}/{name}/{id}`

```json
{"_type": "Документ.РеализацияТоваровУслуг", "ref": "…", "presentation": "Реализация 000012 от 05.09.2026",
 "deletion_mark": false, "posted": true,
 "standard": {"Номер": "000012", "Дата": "2026-09-05T10:00:00"},
 "attributes": {"Контрагент": {"_type": "Справочник.Контрагенты", "ref": "…", "presentation": "…"}, "СуммаДокумента": 224000},
 "tables": {"Товары": [{"Номенклатура": {…}, "Количество": 20, "Цена": 10000, "СтавкаНДС": {…}}]}}
```

`standard` holds `Номер` and `Дата` for documents. For catalogs it holds `Код`, `Наименование`,
`Родитель`, `Владелец` and `ЭтоГруппа`, if the catalog has them.

#### `POST /query`

`{"text": "ВЫБРАТЬ … ИЗ …", "params": {"Дата": "2026-10-01", "Контрагент": {"_type": …, "ref": …}}, "limit": 1000}`
→ `{"columns": ["…"], "rows": [[…]], "truncated": false}`. The 1C query language cannot change data.
Strings shaped like dates become dates, and arrays become lists for `В (&Список)`. The limit
defaults to 1000 rows (maximum 10000). A query that does not compile returns `400 bad_query`.

#### Writes (the write rules above apply)

| Request | Body | What 1C does |
|---|---|---|
| `POST /objects/{kind}/{name}` | `{approval_id, approved_by, fix_id, data, post}` | Creates the object; `post: true` posts a document |
| `PUT /objects/{kind}/{name}/{id}` | `{…, "action": "update", data, post}` | Applies `data`; a posted document is re-posted |
| `PUT /objects/{kind}/{name}/{id}` | `{…, "action": "restore", "snapshot": <before>}` | Undo: puts back attributes, tables, the deletion mark and the posted state |
| `POST /objects/{kind}/{name}/{id}/post` | `{approval_id, approved_by, fix_id}` | Posts |
| `POST /objects/{kind}/{name}/{id}/unpost` | same | Unposts |
| `POST /objects/{kind}/{name}/{id}/mark_deletion` | same | Marks for deletion (unposts a posted document) |
| `POST /objects/{kind}/{name}/{id}/unmark_deletion` | same | Clears the deletion mark |

`data` = `{"standard": {...}, "attributes": {...}, "tables": {"Товары": [rows]}}`. Every key is
optional, and a tabular section that is sent replaces the existing one completely. An unknown
field returns `400 bad_attribute`.

→ `{"fix_id", "ref", "before", "after"}`, where `before` and `after` are full objects (`before` is
`null` for create).

---

## 2. Agent ↔ backend WebSocket (`/agent`)

The agent connects with `Authorization: Bearer <agent token>` (one per company, issued and
revoked in the web app; only the hash is stored) and `X-Agent-Version`. JSON text frames:

| Direction | Message |
|---|---|
| agent → backend | `{"type": "hello", "version": "1.0.0"}` |
| agent → backend | `{"type": "heartbeat"}` every 30 s → backend answers `{"type": "heartbeat_ack"}` |
| backend → agent | `{"type": "command", "id": "<uuid>", "command": "<name>", "params": {...}}` |
| agent → backend | `{"type": "result", "id": "<uuid>", "reply": {"ok": true, "data": ...}}` or `{"ok": false, "status": 409, "error": {...}}` |

Commands and the extension call each one maps to:

| Command | Params | Extension call |
|---|---|---|
| `ping` | — | `GET /ping` |
| `get_catalog` | `name`, `changed_since?`, `refs?` | `GET /catalogs/{name}` |
| `get_documents` | `type`, `from?`, `to?`, `refs?` | `GET /documents/{type}` |
| `get_ledger` | `from?`, `to?`, `refs?` | `GET /ledger` |
| `get_balances` | `date`, `account?` | `GET /balances` |
| `get_changes` | `since?` | `GET /changes` |
| `create_invoice` | invoice payload | `POST /invoices` |
| `post_invoice` | `approval_id`, `ref`, `approved_by` | `POST /invoices/{ref}/post` |
| `apply_fix` | fix payload | `POST /fixes` |
| `get_fix` | `id` | `GET /fixes/{id}` |
| `get_metadata` | — | `GET /metadata` |
| `list_objects` | `kind`, `name`, `refs?`, `filter?`, `from?`, `to?`, `limit?`, `offset?`, `include_deleted?` | `GET /objects/{kind}/{name}` |
| `get_object` | `kind`, `name`, `ref` | `GET /objects/{kind}/{name}/{ref}` |
| `run_query` | `text`, `params?`, `limit?` | `POST /query` |
| `write_object` | `approval_id`, `approved_by`, `fix_id`, `kind`, `name`, `action`, `ref?`, `data?`, `post?`, `snapshot?` | create → `POST /objects/{kind}/{name}`; update/restore → `PUT …/{ref}`; others → `POST …/{ref}/{action}` |

Backend side (Redis):

* `agent:queue:{company_id}`: pending commands. Writes wait here while the laptop is offline.
* `agent:processing:{company_id}`: sent but not yet answered. Re-sent after a reconnect, which is
  safe because 1C applies each `approval_id` once.
* `agent:result:{command_id}`: the reply, for callers that wait (reads).
* `agent:online:{company_id}`: set with a TTL on every heartbeat.

If the laptop is offline, reads come from the mirror (the UI shows "last synced"), and writes wait in
the queue and run on reconnect.

---

## 3. Backend direct 1C API (`/api/onec/{company_id}/...`)

The browser and MCP side of the direct API. Every call goes live through the agent to the
company's own base. If the agent is offline the call returns `503`, and if 1C does not answer in
time it returns `504`.

| Request | Who | What |
|---|---|---|
| `GET /metadata` | anyone with access to the company | `GET /metadata` |
| `GET /objects/{kind}/{name}?filter=<json>&from=&to=&limit=&offset=&include_deleted=` | same | list |
| `GET /objects/{kind}/{name}/{ref}` | same | one object |
| `POST /query` `{text, params, limit}` | owner, accountant | 1C query (logged as `onec.query`) |
| `POST /changes` `{kind, name, action, ref?, data?, post?, explanation}` | owner, accountant | **proposes** a change |

`POST /changes` never writes to 1C. It reads the object's current state, refuses a closed period
with `409`, and creates a fix of type `object_write` with a before/after preview. The change runs
only after someone approves it on the Fixes page (`POST /api/fixes/approve`). Approval issues the
`approval_id`, the agent sends `write_object`, and the mirror re-syncs the touched object. Undo
(`POST /api/fixes/{id}/undo`) proposes a `restore` from the stored `before`. Undoing a create
proposes `mark_deletion`.

MCP exposes the same calls as the `onec_metadata`, `onec_list_objects` and `onec_get_object`
tools, plus `onec_query` and `onec_propose_change`. The last two are not shown to viewers.

### Right-base guard

Each agent token belongs to one company, so every call must reach that company's base. Before
syncing, and before any live read or write (at most once every 10 minutes per company), the
backend pings 1C and compares two things:

* the reported `inn` with the company's INN. An empty company INN is filled in from the first ping;
* the reported `base_name` with the last part of the company's `base_path`.

On a mismatch it stores `companies.base_error`, logs `agent.wrong_base`, and refuses with
`409`. Sync is skipped, live reads and new proposals are refused, and fix approval is blocked.
The web app shows the error in the header. The error clears on the first ping that matches again.

---

## 4. Direct connection (`/api/admin/...`, owner only)

A company can reach 1C without the agent, over the base's standard OData interface
(see [`direct-connection.md`](direct-connection.md)). `services/odata.py` answers the same
commands as the agent (section 2), so everything above works on either transport. The exception
is `run_query`, which returns `501`.

| Request | Body | What |
|---|---|---|
| `POST /onec/test` | `{address, base, username, password, company_id?}` | Tries the connection without saving → `{ok, error?, organizations, found, missing}` |
| `POST /companies/connect` | the same plus `organization_ref?`, `name?` | Creates a company from the 1C organization, saves the connection, runs a full sync |
| `POST /companies/{id}/connection` | the same; an empty `password` keeps the stored one | Tests and saves; refuses with `409` if the base's INN is another company's |
| `GET /companies/{id}/connection` | — | `{connection_type, direct: {url, address, base, username, last_ok_at, last_error}}`; the password is never returned |
| `DELETE /companies/{id}/connection` | — | Back to the agent; the stored address and password are deleted |
