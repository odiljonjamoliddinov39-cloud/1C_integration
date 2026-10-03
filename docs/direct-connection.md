# Direct connection to 1C (no agent, no extension)

The app can talk to a 1C base directly over the base's **standard OData interface**. This REST
interface is built into the 1C platform, so you only need to publish the base and pick a user.
Nothing is installed in the configuration, and no agent runs on the laptop.

## 1. In 1C (once per base, about 10 minutes)

1. **Publish the base on a web server.** Open the base in the Configurator, then go to
   *Администрирование → Публикация на веб-сервере*:
   - choose IIS or Apache. IIS is part of Windows: *Turn Windows features on or off → Internet Information Services*;
   - tick **«Публиковать стандартный интерфейс OData»**;
   - press **«Опубликовать»**.

   The base is now at `http://<computer>/<publication name>/`.
2. **Choose what the app may see.** In 1C:Enterprise, open *Администрирование → «Настройка
   стандартного интерфейса OData»*. In some releases it is under *Синхронизация данных*. Allow
   the objects below, or all of them:

   | Needed for | OData name |
   |---|---|
   | Organization and INN (right-base check) | `Catalog_Организации` |
   | Counterparties, contracts, items | `Catalog_Контрагенты`, `Catalog_ДоговорыКонтрагентов`, `Catalog_Номенклатура` |
   | Documents | `Document_РеализацияТоваровУслуг`, `Document_ПоступлениеТоваровУслуг`, `Document_СчетФактураВыданный`, `Document_СчетФактураПолученный`, `Document_ПриходныйКассовыйОрдер`, `Document_РасходныйКассовыйОрдер`, `Document_ПоступлениеНаРасчетныйСчет`, `Document_СписаниеСРасчетногоСчета`, `Document_ОперацияБух` |
   | Entries, balances, account codes | `AccountingRegister_Хозрасчетный`, `ChartOfAccounts_Хозрасчетный` |
   | Closed period (optional) | `InformationRegister_ДатыЗапретаИзменения` |

3. **Create a 1C user for the app.** Give it the rights it needs: read for analytics and audit;
   change and posting for fixes and invoices. Use a long password.

Check it in a browser: `http://<computer>/<publication>/odata/standard.odata/` asks for the 1C
login and then lists the published objects.

## 2. In the app (1 minute)

Go to *Admin → Companies → **Connect a 1C base*** (or **Connect 1C** on an existing company) and
fill in:

| Field | Example |
|---|---|
| Server address | `192.168.1.10`, `buh-pc:8080`, or `https://1c.company.uz` |
| Base name | the publication name, e.g. `TEST_CRYSTAL` |
| 1C username / password | the user from step 1.3 |

Then:

1. **Test connection** shows the organization and INN found in the base. It also lists which
   needed objects are not published yet.
2. **Connect and sync** saves the connection and runs the first full sync. For a new base it also
   creates the company from that organization.

The password is stored encrypted, using a key derived from `SECRET_KEY`. It is kept in its own
table, which the read-only Ask AI role cannot see. If `SECRET_KEY` changes, enter the password again.

## Network

The **backend** (not the browser) connects to the address, so the server running the app must be
able to reach it:

* **App in the same office network** (Docker on a local PC or server): use the LAN IP. This is the simplest.
* **App on a VPS**: connect the office to the VPS through a VPN (WireGuard or similar) and use the
  1C computer's VPN address. Publishing 1C to the internet works with HTTPS and a firewall that
  allows only the VPS's IP, but a VPN is safer.
* If you can't do either, use the agent: it needs no inbound access at all.

## How it behaves

| | Direct (OData) | Agent + extension |
|---|---|---|
| Sync, audit, analytics, Ask AI | ✓ the same mirror | ✓ |
| Fixes and invoices | ✓, after approval | ✓, after approval |
| Direct API: metadata, lists, objects, changes | ✓ | ✓ |
| 1C queries (`POST /query`) | ✗ (501) | ✓ |
| Finding changes | Compares each object's `DataVersion` with the last sync | Change-registration register |
| Merging counterparties | Several HTTP calls, in a fixed order | One 1C transaction |
| Change log | Backend (`fixes`, `event_log`) | Backend and `ЖурналИзмененийAI` |
| 1C unreachable | Header shows offline; sync skipped; a write fails and can be approved again | Writes wait in the queue |

The right-base guard works the same way: before syncing or writing, the INN reported by 1C must
match the company. Connecting a base whose organization has a different INN is refused.

## Names

The connector uses the same configuration names as the extension (`AIAPI_Метаданные`), in
`backend/app/services/odata.py` (`DOCUMENTS`, `CATALOGS`, `A`). OData adds its own standard names:
`Ref_Key`, `Description`, `Code`, `Number`, `Date`, `Posted`, `DeletionMark`, `Owner_Key`, and
`_Key` on reference attributes (`Контрагент_Key`). VAT rates can be numbers, an enum
(`НДС12`) or a catalog. The connector reads which one it is from `$metadata`.

> Tested against a fake OData server (`backend/tests/fake_odata.py`) that follows 1C's format.
> Before connecting a live base, check `TEST_CRYSTAL` with *Test connection* and a first sync.
> If an attribute name differs in your release, change it in `odata.py`.
