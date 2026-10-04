# Field map: Бухгалтерия для Узбекистана, редакция 3.0

What `PlatformAPI_Map.bsl` assumes. Each name is **to verify** until it has been checked
against the real metadata (`pnpm --filter @platform/onec-client metadata ...`, which writes
`*.metadata.json` next to this file). Once a name is confirmed, mark it ✔ here.

## Счет-фактура полученный (phase 0)

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
