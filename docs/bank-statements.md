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

## Several accounts, one period: the account ledger

A company's bank accounts are not separate worlds, and a real import is several statements at once (a settlement
account, a special account for blocked funds, a transit account the bank passes its fees through, accounts in a
currency). `bank/ledger.ts` reads them together, in whole tiyin, with no AI, before anything is entered:

- **Header**: any 20-digit account in the heading (not only 202…), the printed `Остаток: Начало дня / Конец дня`
  and a check that the rows add up to it (a mismatch means missing rows or swapped In/Out, said before anything is
  entered). In the columns, "Наименование счёта" is the counterparty's name and "№ счёта" its account.
- **Period**: `propose_bank_payments` takes `from`/`to`; the program picks the rows, the model never reads the file
  for them (a bank statement's rows are refused to `read_attachment` after a few reads; totals stay allowed).
- **Pass-through accounts**: a statement that opens and closes at zero, takes in only from the company's own
  accounts and pays out the same is left out (its rows are the other legs of payments in the other statements). What
  it passes decides what the payments to it are: the bank's fees (names/purposes "комиссия", "тариф", "SWIFT" …) are
  entered as fee documents with no counterparty; a currency conversion is a transfer, not a payment.
- **Transfers between own accounts**: matched with their other leg (same day and amount, the other way, the other
  account) and **entered by the program** (`bank/transfer.ts`) as a pair of documents, one on each account's side: the
  company's own newest posted document of the operation «Перевод на другой счёт организации» / «Перевод с другого
  счёта» (or the conversion operation) is copied, preferring one between the same two accounts, and only its date,
  amount, number, purpose and the two accounts change. A leg whose statement is not attached is not entered (it is, with
  its statement); a leg already in 1C (the same account, day and amount) is left out; when 1C has no such document or
  the account, the reason comes back and nothing is guessed. A payment to the company's own INN from an account that
  is not attached is a transfer too (or a fee, when its purpose reads as one).
- **Currency**: digits 6–8 of the account (`000` UZS, `643` RUB, `840` USD, `978` EUR). A foreign-currency account is
  **entered in its currency**: each payment is copied from the counterparty's newest posted payment _in that
  currency_ (an earlier one in soums is never copied for a dollar account, nor the reverse), the amounts are those of
  the statement, and the exchange rate is the one of the payment's day from 1C's rate register
  (`РегистрСведений.КурсыВалют`; the catalog's numeric code or letters are tried). Where the earlier payment settled
  in soums, the settlement amount follows the new rate; where it settled in the currency, it follows the payment.
  When 1C has no rate for the day the earlier payment's rate is kept and a note says so. A conversion between a
  soum account and a currency account has two legs of different amounts; the program reports it, it does not pair it.
- **One run**: with no `file`, every attached statement is handled in one run and one card; answers to what could not
  be settled carry the file. What cannot be settled comes back with each row's date, amount, name and purpose.
- A statement of a few payments that names its own account is read by the program too (it is one account of several).

## What is missing is said at once

The moment the first look at the statement is done (before any card, before any model step) the accountant gets a
list, in the language of the last message: the counterparties and contracts 1C lacks, and the rows the program cannot
settle with the reason and the count (`bank/gaps.ts`). The model is told (`alreadyShownToAccountant`) not to list them
again. Counterparties and contracts are then offered for creation on cards, as before.

## A base with no posted payments (found in a real 2024 run)

A year of statements into a fresh base took ~85 minutes and the month's AI budget: only 20 payments had an earlier
posted document to copy, the model typed the rest (163 bank fees among them) in batches, and the 348-document posting
result was cut by the result limit so that its failures were never seen. Fixed:

- **Templates may be unposted.** The earlier payment is looked for among documents not marked for deletion, the posted
  ones first. Documents the program made a moment ago are templates for the rest.
- **Looked at again at once.** After a card is applied, the rows that had no template are resolved again (up to three
  passes, no model step between), each pass on the documents the previous one made.
- **A rate of 0 is soums.** A soum document whose settlement rate was never filled in (0) was refused as "in a foreign
  currency (rate 0)"; it is now a soum document (124 rows in the run).
- **Big batches show their failures first.** Over 30 documents the model gets the counts, the failures and the
  refusals, then a sample, never the whole list.

- **A payment in a currency with only soum payments in the base.** The program makes the first one itself from the
  counterparty's (or, for a new one, the newest copyable) soum payment: the document currency is the currency item of
  1C's catalog, the row carries the rate of the payment's day from 1C's rates, and the settlement is in the currency when
  the contract is in it, otherwise in soums at the rate. It says so in a note (check the first document). Left to the
  accountant: no rate of that day in 1C, no such currency item, or a contract in a third currency.

## Exchange rates (PlatformAPI 0.8.0)

A payment in a currency needs that currency's rate of its day in 1C, and 1C keeps rates in a register
(`РегистрСведений.КурсыВалют`) that is neither a document nor a directory: no change can write to it, and the accountant
was told to load the rates by hand in 1C. Now:

- `SetCurrencyRates` (PlatformAPI): writes rates to the register in one transaction; a day that has a rate already is
  left as it is (the answer lists the days that differ).
- The app reads the Central Bank's rates (cbu.uz, one answer per day, a few at a time) and shows ONE card per run with
  what 1C lacks: the currency, the period, the number of rates, the first and the last, how many 1C has already
  (`propose_currency_rates`, `currency/cbu.ts`). A day that only repeats the rate before it is not written (1C carries a
  rate forward). No internet or no answer from the bank: nothing is written and the card says so.
- A bank run does this by itself, before it resolves a payment on a foreign-currency account: from a week before the
  first payment (the rate in force on that day) to the last one. If the accountant declines, or the bank cannot be
  reached, `ratesNotLoaded` says why.
- Documents in a currency entered before the rates were loaded take the rate when they are posted again.

## Conversions between a soum and a currency account

1C refuses «Перевод на другой счёт» when the receiving account is in another currency («валюта счета получателя не
совпадает»), and the two legs of a conversion have different amounts anyway. The company's way (found in the real 2024
run) is what the program now does, each leg a document of its own in its own currency (`bank/transfer.ts`):

- the paying side: «Прочее списание» (to the transit account, 5710 in that base), copied from the company's earlier
  document of that operation;
- the receiving side: «Перевод с другого счёта», copied from the company's earlier one; a dollar receipt made from a
  soum one takes the currency item of 1C's catalog and the rate of the day (from the rates loaded above).

Unposted documents of those operations are templates too, so the first one is entered by hand once and the rest copy it.
What the program cannot know is said: no document to copy, no rate of the day, no such currency in the catalog. The
difference between the bank's rate and the Central Bank's stays as 1C posts it (the accountant closes it on the
exchange-difference accounts); the note on each leg says so.

## What a real 2024 run showed after the rates (balances, accounts, cost)

- **The transit accounts did not close** (5700 in the balance sheet was red). The dollar leg of a conversion was booked
  at the Central Bank's rate of the day, the soum leg at what was really paid: the difference stayed on 5710/5715. The
  two legs are now paired (the accounts mirror each other, within three days, the rate within 10% of the bank's) and the
  currency leg is booked at the conversion's own rate (soums paid ÷ currency received), so the two sides close; only the
  difference to the Central Bank's rate is an exchange difference, for the month-end revaluation. A leg with no partner
  keeps the Central Bank's rate.
- **Red 6400/6500** (tax and contribution accounts in debit) are payments with no accrual behind them: the base has the
  bank statement but no payroll or tax accruals. The program does not hide it; `ledger_check` names it.
- **Bank accounts are never created** (the run made accounts for bank branches and for counterparties): the company has
  its own few (main, block, dollar, ruble), and the app refuses to create `Справочник.БанковскиеСчета` items.
  The bank's own ledger lines in a statement («К получению с Головного Офиса…», «Депозит до востребования», «транзитный
  счет…») are not created as counterparties either; the row says why.
- **Statements are worked in the order dollar, ruble, then the soum accounts.**
- **Cost.** The model used to read the registers again and again to see the same things. `ledger_check` reads the
  balances once and judges them (cash or bank in credit, transit not closing, liability in debit, receivable in credit,
  exchange differences 95xx/96xx); a question that enters documents is capped at 24 model steps (60 for other questions):
  the program does the work and the model steers, and what is left is continued with the next message.

## Month-end revaluation of currency balances

The revaluation of dollar and ruble balances at each month's end is a regulated operation of 1C («Закрытие месяца →
Переоценка валютных средств»), not a document the app can create, and an exchange-difference document made by hand to
close the balances would only hide a wrong rate. What the app does (`revaluation_check`, `currency/revaluation.ts`):

- For each month's end in the period it reads the currency accounts and the currency settlement accounts (an advance in
  dollars) in one query, takes the rate of that day from the rate register, and works out what each balance in soums
  should be, against what 1C carries: the adjustment, the side (gain on 9540, loss on 9620) and the entry.
- It says which months need the operation and the amounts it must give; the accountant runs 1C's revaluation for those
  months, and the same call afterwards must find no differences. It needs the rates loaded first.

## A cleared base: what the real run showed, and what the program does now (v2)

A real run on a base whose bank documents had been deleted (8 statements: the main account, a block account, two transit
accounts for fees, a dollar and a ruble account) failed for reasons that were all in how the program read 1C, not in the
accountant's data:

- **The company's bank account has another name in the Uzbek configuration** («СчетОрганизации», not «БанковскийСчет»), so
  every document was written with no bank account. The names of the roles are now read from the document itself
  (`bank/roles.ts`: a copied document's own fields, or 1C's description of the object, by type), never assumed.
- **Documents did not post** ("debit account not filled" on 172 payments, "credit account" on 37). The breakdown row had no
  «Погашение задолженности» and no «Счет авансов»: with the way empty 1C books the whole payment to the account of
  advances, finds it empty, and refuses. Every payment document the program makes is now completed
  (`bank/complete.ts`): the way «Автоматически», the account of advances and the settlement account from the account
  rules, found among the columns by name and by the title the form shows, and a currency account for a contract in a currency.
- **Payments to foreign suppliers went to the bank's own ledger line.** In a currency account's statement the bank writes a
  SWIFT payment to «К получению с Головного Офиса - Долларов США». The supplier, the contract and the advance are in the text
  (`BC: /acct NAME … PD: PREPAYMENT PER CONTRACT GR-TI-01 D.D. 30.01.2024`, or the bank's own message with the beneficiary
  after the orderer's address). `bank/swift.ts` reads them (the bank wraps and cuts the text: a name is compared by its letters
  and its beginning, a contract number is read with its spaces removed); `bank/foreign-payees.ts` finds the beneficiary in
  1C by its first word and writes the payment with 1C's own spelling; a return of an international transfer names the day
  and amount of the payment it returns, so it takes that payment's beneficiary and contract. All 33 dollar payments and the
  ruble one of the real statements are read this way.
- **A contract the purpose names and 1C lacks** is made from 1C's description of the directory (`bank/contract.ts`: the owner,
  number, date, kind by the direction of the money, the currency of the payment), on a card, and the payment waits for it.
- **A payment's settlement is worked out, not copied**: the contract's currency is read from the contract; the settlement amount
  is the payment × the document's rate ÷ the contract's rate, and the row carries the contract's rate (1 for a soum contract),
  the document's own rate is in its header («КурсДокумента»). A contract in dollars is posted to an account that can hold a
  currency (the chart's own flag «Валютный», found by `currencyAccount`).
- **Fees, transfers between own accounts and the legs of a conversion are made from the description too** when the base has no
  earlier document to copy (`bank/build.ts`): a fee is «Прочее списание» to the expense account of bank services; a transfer is
  «Перевод на другой счёт» / «Перевод с другого счёта» through the transit account (5710), each side naming the other account.

### Currency conversion, by the technical design (transit account, two linked legs)

A purchase or a sale of currency is **one conversion of two linked legs** and never a move of money between two bank accounts
that nobody sees (`bank/conversion.ts`, `bank/transfer.ts`):

- The bank writes both legs with the same words («Конвертация валютных средств 4165.0 'Доллар США' по курсу 12484.0»), so the
  legs are paired by them: the currency, the amount in it, the rate, the day. Purchase: the soum account pays, the currency
  account takes in; sale: the other way. A leg whose partner is not in the attached statements is left to the accountant.
  On the real statements 37 conversions (35 dollar, 2 ruble) are paired and none is left alone.
- The money passes through the **conversion (transit) account of the direction**: 5730 for a purchase, 5740 for a sale (the
  design's worked example sells dollars through 5740); both are read from the company's chart, and when the chart lacks one the
  conversion stops and says so: it is never booked anywhere else.
- **Leg 1 first** (the paying document, at 10:00:00), **leg 2 a second later**, so that the account never runs negative. Both carry
  the conversion's id in their comment, the bank as the counterparty, and the bank's contract of kind «Прочее» in the leg's own
  currency (one per currency: the design's setup rule); if 1C lacks the bank or the contract the answer says exactly which.
- The currency leg is at the **official rate** of the day (1C's rate register, loaded from the Central Bank), the soum leg is what
  was really paid: the gap is the bank's own rate, which 1C books to its own account (9690 in the design), apart from the
  revaluation of the currency balance (9540 gain / 9620 loss, done by the month-end revaluation, see `revaluation_check`). The
  earlier approach, booking the currency leg at the bank's rate so that the transit account closed, hid that gap and is gone.
- Every conversion comes back with a line: the id, the direction, the amount and the bank's rate, the two linked documents, the
  conversion account, and "the account must close to zero". The design's remaining controls (confirmation limits, duplicates,
  payments to government bodies only to counterparties marked as such) belong to the card and are not part of this change.

What the program still does not do (said by the answers, never guessed): tax payments with no earlier payment of the same tax
(`«Уплата налога»`: the tax, its period and the tax office are the company's own), salary and loan rows, payments to individuals
through the bank's transit account, and the GTD (customs import) part of the design.

### A base with no currency item

Rates are written to the currency's own item in 1C's catalog. On a cleared base the ruble (and any currency never used) has
none, and the rate card failed with "В справочнике Валюты нет валюты с кодом 643 / RUB". The card now makes the item first
(`currency/items.ts`: the numeric code the loader looks it up by, the short and full names, the spelling of the amount in
words) and then writes the rates, as two lines of the same card.

## Bank fees are not tax payments; the company's own account is the organization's

A fee names VAT as a part of its sum ("…Тариф-1 000,00 UZS.в том числе НДС", "комиссия … без НДС"), and a supplier's payment
often says "в т.ч. НДС 12%". That is VAT a price contains, not a payment of VAT, so such a row is never a tax payment: the
bank's fees (iBank, «Тариф», «за документ №…», SWIFT, «Комиссия инобанка», conversion commission, passive-account service)
go the fee way (with no counterparty, to the expense account of the company's rules), and a tax payment is a payment to the
treasury or the tax office (or one whose purpose names the tax outside such a clause). On the real statements 202 of 257 rows
the tax check took were fees.

A bank account's number is looked up among the accounts the **organization** owns: a company is often a counterparty of itself
too, with its own accounts written there, and one number is then in the catalog twice. When it still is not one account, the
answer names the owners ("2 bank accounts of the company have the number … (owners …)", "the account … is in 1C only under
another owner: …") instead of "not found".

The bank's contract of kind «Прочее» per currency (the conversion method's rule) is made on a card when 1C lacks it, dated the
first conversion's day, and the conversion's legs are entered after it.

## Taxes with no earlier payment, payments through the bank's transit accounts, the conversion's bank

**A payment to the budget with no earlier one of that tax** is made from 1C's own description of «Списание с расчетного счета»:
the operation «Уплата налога», the tax of the catalog «Виды налогов и платежей в бюджет» (found by its name; two that could be
it, or none, stop it and are named), the tax period (the purpose's month, else the month before the payment, said in the note),
the tax office as the counterparty 1C has under the INN the statement gives (left empty when it has none), and the account the
tax item itself names, else 6410 (NSBU), said in the note. An earlier payment of the tax, posted or only a sample not yet
posted, is still copied first: the laptop's 1C is the model, the description only fills what it lacks.

**A payment the statement writes to the bank's transit account is written to its real payee** (`bank/transit.ts`):

- «транзитный счет для зач на ПК физ лиц …»: money to an individual's card; the person is in the text («… с Qodirov Farruh
  Bozorovich на поставку …») and so is the contract. He is found among 1C's counterparties by his letters («ИП»/«YTT» in front
  or not), else taken with his INN from his other rows, else offered for creation by name. A payer's 14 digits (an individual
  entrepreneur's) are not an INN 1C keeps: he is found, and created, by name (only an entrepreneur, «YTT …»/«ИП …»).
- «Транзитный счёт МУНИС …» / «таможенных пошлин»: the customs; written to the customs counterparty 1C already has (a
  payment to a government body goes only to a counterparty in the base); when 1C has none, or several, it says so.

**The bank of a conversion** that 1C lacks as a counterparty is offered on a card under the name 1C's own classifier of banks has
for the MFO of the statement's row (never a guess; with no such name it asks for the bank). Its «Прочее» contract per currency
is offered the same way, and the conversion's legs are entered after both.

A payer with a blank INN cell (not zeros) is found by the name the bank wrote, like one with zeros; the bank's own ledger lines
and its fees are not looked up.

The general rule for a bank fee is 9430 (other operating expenses); the company's own rule or the account its history shows
beats it.

## Read first, write second: the classifier, the gate and the acceptance run (the technical design of 26 Oct)

**Every line is classified before anything is written** (`bank/classify.ts`). The counterparty's account decides first (its
first five digits, a table from the real statements: the bank's accounts carry the commission, conversion and SWIFT lines, so a
keyword never outvotes them), then the text and the contract it names:

| First five digits            | Kind                                                                                                                    | Written as                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 16401, 16413                 | bank commission (the bank's transit accounts)                                                                           | the fee, to 9430                  |
| 22613, 22614, 17101          | a leg of a conversion (blocked UZS, the bank's currency account)                                                        | the linked pair through 5730/5740 |
| 16103                        | a SWIFT payment                                                                                                         | in the account's currency         |
| 23402, 22628                 | a payment to the budget (the tax is read from the text's own codes: «Оплата за 46», the budget code 11110/14110/21216…) | «Уплата налога»                   |
| 29801                        | customs duties                                                                                                          | to the customs counterparty       |
| 23120                        | an individual's card top-up                                                                                             | to the person the text names      |
| 202xx, 10101, 17409, 29896 … | a payment under a contract                                                                                              | by the contract the text names    |

Each answer has a **confidence**: `high` (the account and the text agree), `medium` (an unknown account, or the text points to
another kind than the account does), `low` (no text, or a foreign currency named on a soum account). **Only a high one is
entered**; the rest are listed for the accountant with the reason (the gaps text, and `unclassified` in the tool's answer), and
the model is told not to enter them on a guess. A statement that gives no counterparty account is read by the INN and the name
(never a bank's own ledger line). Conversions are checked too: the soums must be the foreign amount times the rate; a pair that
does not agree is not entered and is listed (`conversionsNotAgreeing`).

Each entered line carries a note: what it was read as, by which rule, with what confidence; a conversion's documents carry its
id in the comment. Nothing is written before the accountant confirms the card, as before.

**The acceptance run** (read-only; nothing is written): `npx tsx apps/desktop/scripts/bank-acceptance.ts <folder> [INN]`.
On the eight Texmash Import statements it reports: the main account's 720 lines agree with the statement's balances
(→ 63 500 366.52); 365 commission lines, 34 607 027.67 (all to 9430); 85 budget lines, 71 773 370.40, of them 6 VAT,
57 067 900.00; 37 conversions paired and agreeing with their rates; 22613 blocked 3 648 397 126.50 = sold + returned, ending at
zero; 704 lines would be entered, 3 held (a treasury return and two payments through the treasury account that are no tax).

## Cash, a founder's contribution, the confirmed table and taking back (the rest of the technical design)

**The table of counterparty accounts is the accountant's, confirmed once** (`bank_mapping`): the program's own rows (the table
above) are applied from the start, and while no row is confirmed the answer says so once, so that the model asks the accountant
ONE question. `confirm` stores the table (or the prefixes named) and is never asked about again; `set {prefix, type?, account?}`
changes or adds a row (a fee's account must be in the company's chart and becomes the company's rule for the bank fee, so the
builder takes it). A confirmed row beats the default in the classifier; a changed row is recorded as a correction.

**Cash paid into the bank** (a line whose text says «взнос наличными», «сдача наличных», «пополнение счета наличными» and names
no contract) is two steps through the transit account 5710: the bank receipt «Взнос наличными» Dt 5110 / Cr 5710 (the line's
document, made from 1C's description), and the cashier's cash order Dt 5710 / Cr 5010, which the program looks for (the same
amount within three days) and, when the company has not entered it, makes from the description of «Расходный кассовый ордер»
(its operation, the single cash desk 1C has, the account the rules name); with several cash desks, or none, it says so and 5710
stays open. **Cash taken out** is the reverse (bank write-off Dt 5710 / Cr 5110, then the cash receipt Dt 5010 / Cr 5710).
**A founder's contribution** (the text names the charter capital and the founder has an INN) is the bank receipt with the founder
as the counterparty, Dt 5110 / Cr 4610; the capital itself (Dt 4610 / Cr 8330) is the accountant's operation and the note says to
check it. The accounts are in the table of account rules (`cash_deposit`, `cash_withdrawal`, `capital_contribution`,
`cash_to_bank_order`, `cash_from_bank_order`) and are checked against the chart: a missing account refuses the document.

**Taking back** (`propose_undo_bank`, or the short message «отмени» / «bekor qil» / «undo»): every document the program writes from
a statement is logged (the line, what it was read as and by which rule, the conversion it is a leg of, the order of writing).
Taking back is one card of deletions (1C unposts a document it marks for deletion; the mark can be lifted): the newest card's
documents (`last`), all of them (`all`) or one conversion; the later document goes before the earlier, and a conversion's other
leg always goes with it. The statement's lines become enterable again. Only what the program wrote is taken back.

## Fixes from the laptop run of 26 October

- A payment copied from one in soums for a contract in a currency gets the currency accounts (6015/4315): the soum ones (6010/4310) are replaced, a currency account the copy already had is kept. Before, 1C answered «Не заполнен счет дебета» and did not post them.
- INPS: «Отчисления в ИНПС» and «191 ИНПС Пеня» are told apart by the code (101 / 191) and the word «пеня» in the text, both when a tax item is chosen and when an earlier payment of the same tax is looked for.
- An earlier document whose breakdown is empty or does not add up to its amount (a hand-made sample) is no longer refused: its row is made for the new amount, with a note.
- Several counterparties under one INN: the one the statement's own name fits is taken (a note says so); only when the names do not tell them apart is the accountant asked.
- «100 процент оплата» is a prepayment, not interest on a loan.
- A counterparty 1C has with no contract at all gets the neutral «№б/н» contract on a card, as a new one does.
- A move from the settlement account to the blocked-funds account (both soums) is copied from the company's plain transfer between accounts when it has no conversion-named document.
- The moves and conversions the program could not enter are listed in its own answer, with the reasons (before, only the payments were listed and the model guessed the rest).

- Payments to the budget that name no tax (customs prepayments «для лицевого счета УГТК», a refund «возврат на р/с»): the accountant can set the rule once, `bank_mapping set {prefix: "23402", type: "contract_payment", untaxed: true}` (stored as `23402:untaxed`). Those lines are then a payment (a receipt) under the Treasury's contract, not a tax; a text that names a tax stays a tax.
- A move between two soum accounts of the company with only one statement attached: the other side is made from the same row, mirrored (the other direction, the other account), so that both sides are in 1C. When the other statement is read later, its row is found in 1C already.

- A payment to the budget is «Уплата налога» itself, never «Уплата налога за третьих лиц» (which contains the same words and may come first in 1C's list): an operation named by a phrase is the value that is exactly the phrase, and for a tax the third-party one is never taken, nor copied from.
- «Счет учета» of the tax document is the bank's own ledger account (5110): the program no longer writes the tax account over it. The account of the tax (e.g. 4420.1 for personal income tax) is 1C's, from the tax and the kind of liability; the kind («Налог» or «Пеня») is set from the text.

## Fixes from the second laptop run (empty base)

- The tax history query had a condition on the operation's presentation, which 1C does not allow in a condition: every tax payment was refused («1C could not be asked for the company's tax payments»). The operation is read as a column and filtered in the program.
- A table row set too broadly (23402, 29801 as «contract payment») no longer turns a payment to the Treasury that names a tax, or a customs payment, into a held line: the program's own reading of those prefixes applies to them.
- A move between the company's accounts finds the other account in «СчетКонтрагента» (the Uzbek configuration), where it used to find no attribute.
- Of several currency accounts in a group, the one of the plain account's own kind (6010 → 6015, 4310 → 4315) is taken.
- Names of one foreign beneficiary that the bank cut differently («… TOWER B JINSH», «… TOW ER B JINSH», «… TOWER B JINSHA») are one counterparty, made once under the longest spelling.

## One document of 1C stands for one row of the statement

- What 1C already has is matched by the bank account, the day and the amount, and then by the bank number or the counterparty; a payment with no counterparty of its own (a tax, a fee, cash) matches by the account, the day and the amount alone, whatever kind of document it was entered as (a tax first entered as a payment to a supplier is not entered again as a tax).
- Each document of 1C is used up by the first row it matches: two equal rows of a statement need two documents.
- The documents are read in windows of a quarter (5000 rows each); before, one read of 1000 rows hid the rest of a long period and the payments beyond it were entered a second time.
- The same for the moves between own accounts. The assistant is told never to create a bank document by hand that 1C may already have.

## The limit of a query, and the search for documents entered twice

- **One query returns at most 1000 rows; the connector refuses a larger limit.** The reads of what 1C already has (payments, moves between own accounts, Didox sales) asked for 2000 and 5000: 1C refused, the program took that for "nothing there" and entered everything again. All of them now read a period through `query-window.ts`: a period that fills the limit is split in halves until every part fits, and none is hidden.
- **Searching for duplicates** (`propose_bank_duplicates`, and by itself, with no model, for «икки марта киритган ҳужжатларингни ўчир», «takror», «дубли», «twice»): the attached statements are the truth. A bank account, a day, an amount and a direction that a statement lists n times are n documents in 1C, whatever the kind of each (a payment, a transfer, a conversion leg, a tax entered as a payment to a supplier). The extra ones are marked for deletion on one card, the later copy first; the document that carries the row's bank number stays, then a posted one, then the earliest.
- What no row of the statements stands behind (a fee split off a payment, an entry of an account whose statement is not attached) is reported, never touched. The answer says how many rows and documents were checked, and how many were left alone and why.
- The assistant is told never to say "no duplicates" from its own queries: it calls the tool and reports what it says.

## Postings of the moves between the company's accounts

A bank document is booked on the bank's side to the ledger account named in its «Счет учета» («СчетБанк» in the Uzbek
configuration): 5110 for the settlement account, 5530 for the account of blocked funds, 5210 for a currency account. A form
fills it from the card of the bank account; a document written through the API did not, so every document carried the default
and the blocked-funds account stayed empty while the settlement account took its money (the negative balances of both).
Moves written as the operation «Перевод на другой счет организации» / «Перевод с другого счета» had the same trouble: without
the form they post to the wrong account or not at all.

What the program does now:

- **New documents.** A move between two accounts in soum is built from the 1C description of the documents as «Прочее списание» on
  one side and «Прочее поступление» on the other, through the transit account (5710), never as «Перевод…». Every bank document
  the program makes gets the ledger account of its bank account, read from the bank account's card
  (`bank/ledger-account.ts`). An account whose card names none is said in the notes, never guessed. Conversions between
  currencies still follow a sample of the company's own.
- **Documents already in 1C.** «Fix the postings» (`propose_fix_bank_postings`, or the words «исправь проводки», «provodkalarini
  tuzat», «fix the postings» without the model) reads the bank documents of the statements' period and finds the ones whose
  «Счет учета» is not their bank account's (set right, posted again) and the «Перевод…» ones that a statement row stands behind
  (taken back, then entered again from the statement the new way). One card lists the deletions and the changes; nothing is
  touched before it is accepted. Rows of the retired documents are free again for the entry (`bank/postings.ts`).
- The button «Fix the postings» is offered next to «Find the duplicates» when the answer speaks of a mismatch or a negative balance.

## Rules that must not depend on which company is selected (27.10)

The real run on the eight statements (867 documents) needed three corrections by the accountant. Each is now a rule of
the program, not a habit learned from one company's earlier documents:

- **A currency purchase takes the currency in as «Приобретение иностранной валюты»** (the receiving leg, `build.ts`). The
  first run wrote «Прочее поступление». A base that has no such operation falls back to the old phrases and says so in the
  note. A sale of currency is not changed: the operation of its legs is still to be confirmed by the accountant.
- **A leg's contract is settled in the leg's own currency** (`transfer.ts`). When the contract found for a dollar leg is
  settled in another currency, the leg is not written and the reason is on the card (the first run put a ruble contract on
  dollar receipts).
- **A statement of another company is not read** (`bank/owner.ts`). The company's own accounts are counterparties in each
  other's statements and those lines carry its INN; if that INN is not the selected company's, `propose_bank_payments`
  stops with `STATEMENT_OF_ANOTHER_COMPANY` before anything is entered. With no line to an own account there is nothing to
  judge by and the import goes on as before.

Not changed, and still the accountant's decision: the VAT rate row (12%, amount 0) that stays on a purchase document, and
whether the document's rate is the Central Bank's or the bank's (the payment text carries the bank's).

## The operation of a bank document is worked out, not fixed (`bank/operations.ts`, `bank/verify.ts`)

Earlier the program wrote a fixed operation for each kind of line («Прочее списание» for a move, «Уплата налога» for a tax…) and
fixed transit accounts. That held for one company's way of booking and broke for another's. Now a line is a **case** (`fee`,
`transferOut`/`transferIn`, `conversionOut`/`conversionIn`, `tax`, `cashIn`/`cashOut`, `capital`) and what 1C is told is worked out,
in this order, with the source named in the note beside each document:

1. **The accountant's decision** for the case (`bank_mapping` action `set_operation {case, operation}`; kept per company;
   `clear_operation` takes it back; `operations` lists the cases, the decisions and what was seen posted).
2. **The company's own books.** `operationProfiles` reads what each operation of the bank documents has posted in the last two
   years (the pairs of accounts, grouped by operation). An operation fits a case when its entries are the entries the case needs:
   the company's bank account (group 51/52/55) on one side and the right kind of account on the other (transit 57 for a move or a
   conversion, an expense account for a fee…, `familyOf`/`EXPECTED`). The most used fitting operation wins, and the account the
   other side is booked to is the one its own documents use (a company whose moves go through 5720 gets 5720, not the prior 5710).
3. **The meaning of the name** among the values 1C has, in Russian, Uzbek (Latin and Cyrillic): «Прочее списание» for a move,
   «Приобретение иностранной валюты» for the receiving leg of a purchase of currency and not for a sale (`variant`). It also
   breaks ties between operations that both fit.
4. **Nothing fits.** No document is made; the card lists the operations 1C has with what each posted, and the accountant names
   one (the model asks once, `set_operation`). Before that, for a move that cannot be made from the description, the company's own
   operation that does only this (nine entries in ten are such a move) is copied from its newest posted document, and the note says so.

An operation of a form («Перевод на другой счет») is not made from the description unless the books show it posting through the
transit: made from the description it posts to the wrong account, or not at all.

**What 1C posted is read back.** After «проведи», the entries of the posted documents the program wrote (fee, moves, conversion
legs) are read from the register and judged against their case (`verifyPosted`). The answer says how many documents made the entry
their case needs and, for each operation that went wrong, how many and the entry it made («Dt 4220 / Kt 5110»). The operation is
remembered as wrong for that case in this company (`operationVerdicts`; more wrong than right) and is not chosen again; «исправь
проводки» corrects the documents already written. Budget payments, cash and capital are not judged (they have many right shapes).

Account families are by the group of the code (`familyOf`): 50 cash, 51/52/55 bank, 57 transit, 40 customers, 60 suppliers,
44/64/65 taxes, 83 capital, 9x expenses.

Not changed: the conversion transit accounts (5730 purchase, 5740 sale) are still the program's prior, checked against the chart;
the direction of a conversion cannot be read from the books of a company alike.
