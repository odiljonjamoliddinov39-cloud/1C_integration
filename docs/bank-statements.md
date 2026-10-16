# Bank statements with no AI doing the reading

An attached Excel or CSV bank statement is read by the program (`apps/desktop/src/main/bank`):

1. **Parser** (`statement.ts`). The header row is found by its words (Дата, № док, Корреспондент,
   ИНН, Дебет, Кредит, Сумма, Назначение… also Uzbek), each payment becomes one line in whole tiyin.
   Дебет is read as money out of the account, Кредит as money in (or the sign of one amount column);
   the summary says which, and which heading was taken for which column. Rows without a date
   (totals, balances) are ignored. Checks: no amount, both sides filled, negative amount, duplicate,
   INN that is not 9 or 14 digits, no document number.
2. **What the model gets** is the summary only (totals by month and direction, the columns taken, the
   rows to look at), not the rows. The file stays on the PC for `read_attachment`. A statement of
   fewer than 5 payments is sent whole as before.
3. **`propose_bank_payments`** (title only) turns the payments into 1C documents:
   - the organization's own bank account is found by the account number in the statement,
   - each counterparty by INN,
   - each payment is a copy of the counterparty's newest posted payment document of the same kind
     (`ПоступлениеНаРасчетныйСчет` / `СписаниеСРасчетногоСчета`), so the contract, the settlement
     accounts, the cash flow item and the payment breakdown are the company's own; only the date, the
     amount (the breakdown row scales with it), the bank document's number and the payment purpose
     change,
   - payments already in 1C (same day, counterparty and amount) are left out,
   - documents are left unposted; all of them go on one card.
4. What cannot be settled comes back to the model grouped by counterparty (`NO_INN`,
   `COUNTERPARTY_NOT_FOUND/AMBIGUOUS`, `NO_TEMPLATE`, `BAD_TEMPLATE`, `BANK_ACCOUNT_*`, `CHECK`). The
   model answers with references (`counterparties`, `templates`, `ownAccount`), never with documents.
   A payment is not copied when the earlier one was split over several contracts, is in a foreign
   currency, or its breakdown does not add up to its amount.

## What the first real run showed (13.10.2026 statement, 26 payments)

The model entered them by hand in 20 minutes because the tool failed: the copied document was written
with an English `Date` field, which 1C does not have (its standard attribute is `Дата`). Also found:

- the earlier payment was looked up with a reference as a query parameter, which a query cannot compare;
  it is now looked up by the counterparty's INN (`Т.Контрагент.ИНН = &инн`),
- acquiring (`SmartVista - Выручка …`) and bank-fee (`погашение Дебетовый оборот`) rows have no
  counterparty to copy from: they are copied from the newest posted payment whose purpose has the same
  words (digits and punctuation ignored, `shapeOf`); with an INN, a same-kind payment is preferred too,
- the purpose names the contract ("Договор 4/28 от 01.01.2026г"): it is looked up in 1C by number and date
  and used in the document and its breakdown; when 1C does not have it, the earlier payment's contract
  stays and a note says so,
- the counterparty's bank account (`СчетКонтрагента`) is taken from 1C by the number in the statement,
  and another counterparty's account is never carried over,
- not finding the organization's own bank account no longer stops the payments (a note instead).

Not verified against a real base yet: the attribute names (`БанковскийСчета.НомерСчета`,
`НомерВходящегоДокумента`, `НазначениеПлатежа`, `СуммаДокумента`, the breakdown columns) are the
usual ones of Бухгалтерия для Узбекистана 3.0, and are set only when the copied document has them.
