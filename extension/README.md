# 1C extension `AIAPI` (.cfe)

Everything on the 1C side lives in this configuration extension. The base configuration
(Бухгалтерия для Узбекистана 3.0) is never modified. The extension publishes one HTTP service,
`aiapi`, at `/hs/aiapi/v1/`. Only the agent calls it, on `127.0.0.1`, with a Bearer token.
The full contract is in [`docs/api-contract.md`](../docs/api-contract.md).

The module code is in `src/` as plain BSL. The metadata objects below are created once in the
Configurator, and the module texts are pasted in from `src/`. After that, use
*Конфигурация → Расширения → Сохранить в файл* to get the `.cfe` and load it into the other bases.

> Build and test the extension on **copies** of the bases, starting with `TEST_CRYSTAL`. A live base
> is connected only after the acceptance tests in `docs/acceptance-tests.md` pass.

## 1. Create the extension

Configurator → *Конфигурация → Расширения конфигурации → Добавить*:

| Property | Value |
|---|---|
| Имя | `AIAPI` |
| Назначение | Адаптация (Customization) |
| Префикс имён | *(empty)* |
| Безопасный режим | **No**: the extension writes documents and registers |
| Защита от опасных действий | No |

## 2. Objects to add

### Constant

| Name | Type | Purpose |
|---|---|---|
| `ТокенAIAPI` | Строка(100) | Bearer token the agent must send. Generate a long random string and put the same value in the agent's `agent.ini` (`extension_token`). |

### Information registers (independent, non-periodic)

**`ЖурналИзмененийAI`**: the write log and approval idempotency store.

| Kind | Name | Type |
|---|---|---|
| Измерение | `ИдентификаторОдобрения` | Строка(36) |
| Ресурс | `Дата` | Дата (дата и время) |
| Ресурс | `Пользователь` | Строка(100): web-app user who approved |
| Ресурс | `Операция` | Строка(50) |
| Ресурс | `Объект` | Строка(250) |
| Ресурс | `ДоИзменения` | Строка (неогр.), JSON |
| Ресурс | `ПослеИзменения` | Строка (неогр.), JSON |
| Ресурс | `Результат` | Строка (неогр.), JSON returned to the agent |

**`РегистрацияИзмененийAI`**: what changed, for `/changes?since=`.

| Kind | Name | Type |
|---|---|---|
| Измерение | `Ссылка` | Строка(36), UUID |
| Ресурс | `Вид` | Строка(20): `catalog` / `document` |
| Ресурс | `Имя` | Строка(50): API name (`counterparties`, `sale`, ...) |
| Ресурс | `Счетчик` | Число(15, 0): UTC milliseconds |
| Ресурс | `Удален` | Булево |
| Ресурс | `УдаленФизически` | Булево |

### Common modules

All of them: *Сервер* ✔, *Вызов сервера* ✘, *Привилегированный* ✔.

| Module | Source |
|---|---|
| `AIAPI_Общий` | `src/CommonModules/AIAPI_Общий.bsl` |
| `AIAPI_Метаданные` | `src/CommonModules/AIAPI_Метаданные.bsl` |
| `AIAPI_Чтение` | `src/CommonModules/AIAPI_Чтение.bsl` |
| `AIAPI_Запись` | `src/CommonModules/AIAPI_Запись.bsl` |
| `AIAPI_РегистрацияИзменений` | `src/CommonModules/AIAPI_РегистрацияИзменений.bsl` |

### HTTP service `aiapi`

Корневой URL: `aiapi`. Module: `src/HTTPServices/aiapi/Module.bsl`.

| URL template name | Template | Method | Handler |
|---|---|---|---|
| Пинг | `/v1/ping` | GET | `ПингGET` |
| Справочник | `/v1/catalogs/{name}` | GET | `СправочникGET` |
| Документы | `/v1/documents/{type}` | GET | `ДокументыGET` |
| Проводки | `/v1/ledger` | GET | `ПроводкиGET` |
| Остатки | `/v1/balances` | GET | `ОстаткиGET` |
| Изменения | `/v1/changes` | GET | `ИзмененияGET` |
| СчетаФактуры | `/v1/invoices` | POST | `СчетаФактурыPOST` |
| ПровестиСФ | `/v1/invoices/{id}/post` | POST | `ПровестиСчетФактуруPOST` |
| Исправления | `/v1/fixes` | POST | `ИсправленияPOST` |
| Исправление | `/v1/fixes/{id}` | GET | `ИсправлениеGET` |

### Event subscriptions

| Name | Source | Event | Handler |
|---|---|---|---|
| `AIAPI_ПриЗаписиСправочника` | СправочникОбъект: Контрагенты, ДоговорыКонтрагентов, Номенклатура, Организации | ПриЗаписи | `AIAPI_РегистрацияИзменений.ПриЗаписиСправочника` |
| `AIAPI_ПриЗаписиДокумента` | ДокументОбъект: the 9 documents listed in `AIAPI_Метаданные.ТипыДокументов()` | ПриЗаписи | `AIAPI_РегистрацияИзменений.ПриЗаписиДокумента` |
| `AIAPI_ПередУдалением` | all of the above | ПередУдалением | `AIAPI_РегистрацияИзменений.ПередУдалением` |

To add the base objects as sources, the extension must borrow them (*Заимствовать*): the catalogs,
the 9 documents and the accounting register `Хозрасчетный`. Borrowing does not change the base
configuration.

### Role `AIAPI_Доступ`

Grant: the HTTP service (*Использование*); read on the borrowed catalogs, documents and
`Хозрасчетный`; read and write on the two registers; *Изменение* and *Проведение* on
`СчетФактураВыданный`; *Изменение* on the documents and catalogs touched by fixes; and
*Получение* on the constant. Create a 1C user `AIAPI` with this role only (plus the base's minimal
role, if the configuration requires one). Its credentials go into `default.vrd`.

## 3. Check the names against your base

Every configuration-specific name is in **`AIAPI_Метаданные`**: document and catalog names,
attribute names (`ИНН`, `КодИКПУ`, `СтавкаНДС`, the `Товары` tabular section, ...) and the
closed-period lookup. Lines marked `ПРОВЕРИТЬ` are the ones most likely to differ between
releases of «Бухгалтерия для Узбекистана». Open `TEST_CRYSTAL` and compare them before the first
sync. No other module needs changes.

## 4. Publish on 127.0.0.1 only

1. Install Apache 2.4 and the 1C web server extension module (same platform version as the bases).
2. Copy `apache/httpd-aiapi.conf` into Apache's `conf/extra/` and add `Include conf/extra/httpd-aiapi.conf`
   to `httpd.conf`. Remove or comment out any other `Listen` line.
3. For each base, create `C:/1C/publish/<BASE>/default.vrd` from `apache/default.vrd`: set the
   path to the base and the password of the `AIAPI` user. Only the `aiapi` service is enabled.
   The web client and OData stay off.
4. Restart Apache, then on the laptop:

   ```
   curl -H "Authorization: Bearer <ТокенAIAPI>" http://127.0.0.1:8080/TEST_CRYSTAL/hs/aiapi/v1/ping
   ```

   This should return JSON with the version, base name, INN and platform version (Session 1 done).
5. From another PC on the network, `curl http://<laptop-ip>:8080/...` must give *connection refused*
   (acceptance test "Security").

## 5. Behaviour of write endpoints

* `approval_id` (a UUID issued by the backend when a person approves) is required. Without it the
  extension returns `400 approval_required`.
* A repeated `approval_id` returns the stored result and changes nothing. This makes it safe for
  the agent to resend a command after a dropped connection.
* Each write runs in one transaction (`НачатьТранзакцию` / `ЗафиксироватьТранзакцию`). Any error
  rolls the whole change back.
* Each write adds a `ЖурналИзмененийAI` record: who (web-app user), when, object, before and after.
* A document dated on or before the change-prohibition date (БСП `ДатыЗапретаИзменения`) is
  refused with **409 `closed_period`**, and nothing changes.
