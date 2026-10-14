# Field map: Бухгалтерия для Узбекистана, редакция 3.0

What `PlatformAPI_Map.bsl` assumes. Each name is **to verify** until it has been checked
against the real metadata (`pnpm --filter @platform/onec-client metadata ...`, which writes
`*.metadata.json` next to this file). Once a name is confirmed, mark it ✔ here.

## Поступление товаров и услуг (a received invoice is entered as this; 0.7.1)

The configuration keeps the lines of a supplier's invoice in `Документ.ПоступлениеТоваровУслуг` (tables Товары / Услуги), the
invoice is a document linked to it. The names below are what the extension tries (first existing wins); none is verified yet.
The older table is kept for reference.

## Счет-фактура полученный (phase 0, not used for entering any more)

| Purpose                          | 1C name                                                                         | Status    |
| -------------------------------- | ------------------------------------------------------------------------------- | --------- |
| Document                         | `Документ.СчетФактураПолученный`                                                | to verify |
| Organization                     | `Организация`                                                                   | to verify |
| Supplier                         | `Контрагент`                                                                    | to verify |
| Contract                         | `ДоговорКонтрагента`                                                            | to verify |
| Supplier's invoice number / date | `НомерВходящегоДокумента` / `ДатаВходящегоДокумента`                            | to verify |
| Amounts include VAT              | `СуммаВключаетНДС` (sent as false)                                              | to verify |
| Document total                   | `СуммаДокумента`                                                                | to verify |
| Lines                            | tabular section `Товары`                                                        | to verify |
| Line columns                     | `Номенклатура`, `Количество`, `Цена`, `Сумма`, `СтавкаНДС`, `СуммаНДС`, `Всего` | to verify |
| VAT rate type                    | number, enum (`НДС12`, `БезНДС`) or catalog with `Ставка`; detected at run time | n/a       |
| Our dedup key                    | source + `ExternalID` in our `Справочник.PlatformLog` (no borrowed attribute)   | ours      |

## Catalogs

| Purpose        | 1C name                                             | Status    |
| -------------- | --------------------------------------------------- | --------- |
| Organizations  | `Справочник.Организации`, INN in `ИНН`              | to verify |
| Counterparties | `Справочник.Контрагенты`, INN in `ИНН`              | to verify |
| Contracts      | `Справочник.ДоговорыКонтрагентов`, owner `Владелец` | to verify |
| Items          | `Справочник.Номенклатура`, IKPU in `КодИКПУ`        | to verify |

## Phase 1

`Документ.СчетФактураВыданный`, `Документ.ПоступлениеНаРасчетныйСчет` and
`Документ.СписаниеСРасчетногоСчета`: the metadata script already reads them, and their map is
written once their names are confirmed.
