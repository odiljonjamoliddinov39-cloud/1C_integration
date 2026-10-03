# PlatformAPI: the 1C extension

All reading and writing of 1C data goes through this configuration extension (TD §5). The desktop
app calls its functions over a COM external connection; it never drives the 1C screens. The main
configuration (Бухгалтерия для Узбекистана 3.0) is not changed, and the extension survives 1C
updates.

```
src/CommonModules/
  PlatformAPI.bsl        Ping, GetOrganizations, GetMetadata, CreateInvoiceReceived (JSON in, JSON out)
  PlatformAPI_Map.bsl    configuration names, one module per configuration version
  PlatformAPI_Log.bsl    writes PlatformLog (privileged)
build.ps1                XML dump -> PlatformAPI.cfe, optionally installs it into a base
xml/                     the Configurator's XML dump (created once, see below)
```

> Work on a **copy** of a base (e.g. `TEST_CRYSTAL`) until the phase 0 gate has passed.

## 1. Create the extension (once)

Configurator → _Конфигурация → Расширения конфигурации → Добавить_:

| Property                   | Value                                  |
| -------------------------- | -------------------------------------- |
| Имя                        | `PlatformAPI`                          |
| Синоним                    | `Platform API`                         |
| Префикс                    | _(empty)_                              |
| Назначение                 | Адаптация                              |
| Безопасный режим           | **No**: the extension writes documents |
| Защита от опасных действий | No                                     |

### Objects

**Borrowed** (right-click → _Заимствовать_): `Документ.СчетФактураПолученный`.
On it, add the attribute **`ExternalID`**: Строка(100), _Индексировать_ = Индексировать.

**Catalog `PlatformLog`**: one element per write. Длина кода 0, длина наименования 150, not hierarchical.

| Attribute    | Type                 |
| ------------ | -------------------- |
| `Source`     | Строка(50)           |
| `ExternalID` | Строка(100), indexed |
| `Document`   | ЛюбаяСсылка          |
| `Operation`  | Строка(50)           |
| `UserName`   | Строка(100)          |
| `CreatedAt`  | Дата (дата и время)  |

**Common modules.** Paste each one's text from `src/CommonModules`:

| Module            | Сервер | Внешнее соединение | Привилегированный                         |
| ----------------- | ------ | ------------------ | ----------------------------------------- |
| `PlatformAPI`     | ✔      | ✔                  | ✘ (the connecting 1C user's rights apply) |
| `PlatformAPI_Map` | ✔      | ✔                  | ✘                                         |
| `PlatformAPI_Log` | ✔      | ✔                  | ✔                                         |

**Role `PlatformAPI_User`**: _Чтение_ and _Добавление_ on `PlatformLog`. Give it to the 1C users the
app connects with, alongside their normal accounting role.

Save and update the database configuration (_Обновить конфигурацию базы данных_).

### Dump to XML (so the build is repeatable)

_Конфигурация → Расширения конфигурации → PlatformAPI → Выгрузить в файлы_ → `onec/extension/xml`.
Commit that folder. From then on, edit the BSL in `src/` and run:

```powershell
$env:ONEC_PASSWORD = "..."
powershell -ExecutionPolicy Bypass -File build.ps1 -Base "D:\Bases\TEST_CRYSTAL" -User Admin -Install
```

This builds `PlatformAPI.cfe`, which loads into the other bases with _Расширения конфигурации →
Добавить из файла_.

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
