# Bank statements with no AI doing the reading

An attached Excel or CSV bank statement is read by the program (`apps/desktop/src/main/bank`):

1. **Parser** (`statement.ts`). The header row is found by its words (Дата, № док, Корреспондент,
   ИНН, Дебет, Кредит, Сумма, Назначение… also Uzbek), each payment becomes one line in whole tiyin.
   Дебет is read as money out of the account, Кредит as money in (or the sign of one amount column);
   the summary says which, and which heading was taken for which column. Rows without a date
   (totals, balances) are ignored. Checks: no amount, both sides filled, negative amount, duplicate,
   INN that is not 9 or 14 digits, no document number. An INN of only zeros (what a bank writes where the INN
   was not given) is no INN, and the payer is known by its name: see below.
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

## Tax and budget payments

A payment to the treasury or tax office (receiver name, or a tax named in the purpose) is not copied from
the counterparty's last payment: in the 14.10 run the company's earlier payments to the Ministry of
Finance were all «Оплата поставщику» on 4220, so a copy would have repeated the mistake (the model had
to be told «Dm — это налог»). They come back as `TAX_PAYMENT`; the model answers with a posted
«Уплата налога» document of the same tax as the template, or enters it with `propose_changes`
(operation «Уплата налога», tax, period, tax office, accounts 4450/4460…, no contract, no VAT).
Not built yet: choosing the tax and the period from the purpose by itself.

## The 15.10 run: enumerations and reference types

The copy wrote the operation type (`ВидОперации`, an enumeration) by its presentation ("Оплата
покупателя"). GetObject gives an enumeration value as `{type, ref: <value name>, name: <presentation>}`
and a change takes the value NAME, so 1C refused every document and the model went exploring by hand.
Now the name (`ref`) is written. References keep their `type` too (a field that allows several types
asks for it), including the counterparty, contract and bank accounts the program sets itself.

Not verified against a real base yet: the attribute names (`БанковскийСчета.НомерСчета`,
`НомерВходящегоДокумента`, `НазначениеПлатежа`, `СуммаДокумента`, the breakdown columns) are the
usual ones of Бухгалтерия для Узбекистана 3.0, and are set only when the copied document has them.

## Posting what the chat entered

The chat remembers the documents it created in 1C and left unposted (`chat.created`). "проведи" /
"перевед" / "post" is `propose_post_created` (a title only): the app builds one card with an update
(post) per document, so the model neither lists nor reasons about them (the 26 documents of one statement
took 15 s of model time and a long answer before). 1C's refusals (a closed period, a missing field) are on
the card; what was posted is forgotten, what was refused stays for the next try. Posting or correcting
documents that already exist is no longer counted against the plan's monthly import limit: only creations are.

## A counterparty the statement names and 1C lacks

With an INN of 9 digits and a name the tool creates it: a card for the new counterparties (INN, name,
full name), then, for the payments whose purpose names a contract, a card for the contracts (the contract
of the company's latest payment of the same kind is copied: its kind, currency, settlement rules; the
owner, number, date and name are the new one's; the expiry date is left empty), then the payments, copied
from that latest payment of the same kind (a note says so: operation, accounts and VAT are to be checked).
Each round is looked up again with no step of the model between, so a new supplier costs two more clicks and
no more model time. A purpose that names no contract gets a neutral one, "№б/н от <date of the counterparty's
earliest payment in the statement>" (one per counterparty), made the same way, with its kind set by the
direction of the money (С покупателем for a receipt, С поставщиком for a payment); the note on the payment
says so. Not created: a 14-digit INN (a person) and a row with no name. Creating directory items is not counted against the plan's
import limit (only documents are).

## Card (acquiring) receipts: gross and the commission

The statement's amount of a SmartVista row is the net; the purpose says the gross ("от сумма: 484,580.00")
and the commission ("комиссия (0.2%) 969.16"). When they add up to the statement's amount (to a tiyin), the
tool books the receipt at the gross and the commission as a bank-fee document of its own (`part:
"commission"`), copied from the company's latest acquiring commission document (an outgoing bank-fee
document whose purpose names the commission and the terminal). With no such earlier document the receipt
stays net and a note says why; `splitCommission: false` keeps it net on purpose. A receipt that is already
in 1C is skipped with its commission. Before this, receipts were booked net and the commissions were
not entered (the 13.–15.10 runs), or entered by hand when asked.

## A payer the bank gives no INN (nine zeros)

The statement's INN column then holds `000000000`. That is not an INN: two such payers are not one
counterparty. The payment is marked `innZero`, and the counterparty is looked up in 1C **by its name**
(exactly the name in the statement) instead of by INN: its earlier payments (the template), its contracts
named in the purpose and its bank accounts are found by the name too. If 1C has no counterparty of that
name, it is created under the zeros the bank wrote (the one card of new counterparties), and a later
statement finds it by name again. Two or more counterparties of the same name come back as
`COUNTERPARTY_AMBIGUOUS`. Not looked up by name: a bank fee (the purpose says commission) and an acquiring
receipt, which stay on the no-INN route (copied from a payment of the same kind).

## Banks change their exports: columns are found by the data

A bank's client-bank lets the user choose the fields, their order, the separator and the encoding (a text
export with `~` between fields in Windows-1251, no headings), and banks rename their columns. So the
program does not depend on a template:

- **The separator** of a text/CSV file is the character that splits its first lines into the same number of
  cells most often (`;` `~` `|` tab `,`), and a `.txt` file is tried as a statement too; Windows-1251 is read.
- **Headings are used when it knows them.** When there are none, or in words it does not know, the columns
  are found by what the cells hold: a date column; 20-digit accounts and 9/14-digit INNs, where the one that
  is the same on every row is the organization's own and the one that varies is the counterparty's; amounts
  (one column, or two of which one is empty on every row: the first is read as Дебет = out, the second as
  Кредит = in); the longest text is the purpose, the other text with the most different values the
  counterparty's name; a short whole number that differs on every row is the bank document's number.
- Such a table must also have a counterparty's account or INN, or a Дебет/Кредит pair, to be taken for a
  bank statement (a list of dates, names and amounts is not).
- The one thing the data cannot say is which of the two amount columns is money out: the summary tells the
  model that the columns were found by their data and the totals In / Out are shown, so a reversed reading
  is seen before anything is entered.
