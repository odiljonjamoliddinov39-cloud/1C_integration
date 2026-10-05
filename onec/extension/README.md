# PlatformAPI: the 1C extension

All reading and writing of 1C data goes through this configuration extension (TD §5). The desktop
app calls its functions over a COM external connection; it never drives the 1C screens. The main
configuration (Бухгалтерия для Узбекистана 3.0) is not changed, and the extension survives 1C
updates.

```
src/CommonModules/
  PlatformAPI.bsl        Ping, GetOrganizations, GetMetadata, RunQuery, CreateInvoiceReceived (JSON in, JSON out)
  PlatformAPI_Map.bsl    configuration names, one module per configuration version; extension version
  PlatformAPI_Log.bsl    PlatformLog: the write log and the ExternalID index
build-xml.mjs            src/ -> xml/: the whole extension as Configurator files
xml/                     generated, ready to load into a base (do not edit by hand)
build.ps1                xml/ -> PlatformAPI.cfe with the 1C platform, optionally installs it
```

> Work on a **copy** of a base (e.g. `TEST_CRYSTAL`) until the phase 0 gate has passed.

## 1. Install or update the extension

The extension borrows nothing from the configuration, so the same files load into any base of
Бухгалтерия для Узбекистана 3.0, and loading a newer version keeps the PlatformLog records.

1. Download `xml/` (or `PlatformAPI-xml.zip`) and unpack it, e.g. to `D:\PlatformAPI-xml`.
2. Configurator → _Конфигурация → Расширения конфигурации_. If there is no **PlatformAPI** yet,
   _Добавить_ one: Имя `PlatformAPI`, Назначение _Адаптация_.
3. Select **PlatformAPI**, then _Конфигурация ▾ → Загрузить конфигурацию из файлов…_ and choose the
   folder. Answer _Да_ if it asks to replace the extension.
4. In the extension's window: _Конфигурация → Обновить конфигурацию базы данных_ (F7) → _Принять_.
5. In the list of extensions, untick **Безопасный режим** and **Защита от опасных действий** for
   PlatformAPI: the extension writes documents, and its log switches to privileged mode while it
   writes (1C does not allow privileged modules in extensions).
6. The app's **Ulanishni tekshirish** shows the extension version (`0.2.0`).

What is inside:

| Object                          | Properties                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Common module `PlatformAPI`     | Сервер, Внешнее соединение; the connecting 1C user's rights apply                                                                                          |
| Common module `PlatformAPI_Map` | Сервер, Внешнее соединение                                                                                                                                 |
| Common module `PlatformAPI_Log` | Сервер, Внешнее соединение; turns privileged mode on in its own procedures                                                                                 |
| Catalog `PlatformLog`           | one element per write: `Source`, `ExternalID` (indexed), `DocumentType`, `DocumentID` (UUID), `DocumentPresentation`, `Operation`, `UserName`, `CreatedAt` |

Duplicates are found by source + `ExternalID` in PlatformLog, written in the same transaction as the
document, so no attribute is added to the configuration's documents. A document deleted or marked
for deletion in 1C does not count: importing it again creates a new one.

### Changing the extension

Edit the BSL in `src/`, bump `ВерсияРасширения()` in `PlatformAPI_Map.bsl` and run
`node onec/extension/build-xml.mjs`; commit `xml/` with it (CI checks they match). `build.ps1` turns
`xml/` into `PlatformAPI.cfe` on a PC with 1C, for _Добавить из файла_:

```powershell
$env:ONEC_PASSWORD = "..."
powershell -ExecutionPolicy Bypass -File build.ps1 -Base "D:\Bases\TEST_CRYSTAL" -User Admin -Install
```

## 2. Make the COM connection work on the PC

1. The COM connector ships with the 1C platform. Register it once, as administrator, with the
   **64-bit** platform:
   `regsvr32 "C:\Program Files\1cv8\8.3.xx.xxxx\bin\comcntr.dll"`
2. Node must be 64-bit as well (`node -p process.arch` → `x64`).
3. Each open connection uses a 1C license, like a user.

## 3. Phase 0 checks (TD §13)

From the repo root on the Windows PC (`pnpm install` builds `winax` there):

```powershell
$env:ONEC_PASSWORD = "..."
# Ping + organizations through winax
pnpm --filter @platform/onec-client ping -- --file "D:\Bases\TEST_CRYSTAL" --user Admin
# Real object and field names -> onec/mapping/*.metadata.json; compare with PlatformAPI_Map
pnpm --filter @platform/onec-client metadata -- --file "D:\Bases\TEST_CRYSTAL" --user Admin
# Gate: one unposted Счет-фактура полученный written from JSON (edit the INN and item first)
pnpm --filter @platform/onec-client create-invoice -- --file "D:\Bases\TEST_CRYSTAL" --user Admin fixtures/invoice-received.sample.json
```

Run `create-invoice` a second time: it must return the same `ref` with `"duplicate": true`, and
no second document may appear in 1C.

## Contract

Every function takes and returns one JSON string, always in an envelope:

```json
{"ok": true, "data": {...}}
{"ok": false, "error": {"code": "COUNTERPARTY_NOT_FOUND", "message": "...", "details": {"inn": "..."}}}
```

The schemas are in `packages/shared/src/platform-api.ts`. The error codes are `BAD_JSON`,
`VALIDATION`, `ORGANIZATION_NOT_FOUND`, `COUNTERPARTY_NOT_FOUND`, `CONTRACT_NOT_FOUND`,
`ITEM_NOT_FOUND`, `VAT_RATE_NOT_FOUND`, `CLOSED_PERIOD`, `WRITE_FAILED` and `INTERNAL`.
`WRITE_FAILED` and `INTERNAL` also carry 1C's own error text in `details.onec`, and are logged to
the 1C event log.
