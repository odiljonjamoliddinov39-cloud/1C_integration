# What the program does by itself, and what it leaves to the model

The assistant is two parts: **the program** (exact, fast, no AI cost) and **the model** (judgement, explanation,
anything that has no fixed rule). Everything a rule can decide is moved to the program, so the answer is the same
every time and comes back in seconds.

## Done by the program

| Job                                             | Where                                                    | How                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bank statement rows                             | `bank/statement.ts`, `bank/resolve.ts`, `bank/ledger.ts` | Parsed, read together across accounts, period filtered; counterparty by INN, contract from the purpose, document copied from the company's own earlier one                                                                                                                                                                                                                                                                                         |
| **Payments to the budget**                      | `bank/tax.ts`, `bank/resolve.ts`                         | The tax is read from the purpose (НДФЛ, social, INPS, VAT, profit, property, land, water, turnover, excise). The template is the newest posted «Уплата налога» of the **same tax**, so the operation, accounts, tax office and breakdown are the company's. The tax period is the one the purpose names, else the company's habit (the usual number of months between its payments of that tax and their periods, normally 1). The note says which |
| **Terminal (SmartVista) receipts**              | `bank/acquiring.ts`, `bank/ledger.ts`                    | The bank pays the takings less its commission and writes both. Booked gross, the commission as a bank-fee document of its own. These are no longer taken for moves between the company's own accounts, whatever INN or account the statement shows                                                                                                                                                                                                 |
| Own-account moves, blocked account, conversions | `bank/ledger.ts`                                         | Recognised, matched leg to leg, reported with how 1C records such money (not entered yet)                                                                                                                                                                                                                                                                                                                                                          |
| What 1C holds for a sale                        | `didox/sale-kit.ts`                                      | Warehouses, buyer and contracts, items by name, VAT rates, sales already there, newest sale to copy: read in parallel in one step                                                                                                                                                                                                                                                                                                                  |
| How the company works                           | `bank/policy.ts`                                         | Bank accounts and their use, documents posted, ledger accounts used, contract currencies, the accounting policy register; sent with every model turn                                                                                                                                                                                                                                                                                               |
| **Accounting arithmetic**                       | `calc.ts`, tool `accounting_calc`                        | See below                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## `accounting_calc`: no figure is the model's own sum

Every calculation goes through the program: exact to the cent, parts that must add up do (the last cent goes to the
largest fractional part). Operations:

- `vat`: out of a net or a gross amount.
- `depreciation`: straight line, declining balance, sum of the years' digits, units of output.
- `loan`: annuity or differentiated schedule, totals, balance cleared to zero.
- `npv_irr`: NPV at a rate, IRR by bisection, payback.
- `fx_revaluation`: foreign balances at the closing rate, gain or loss each (an asset worth more is a gain, a liability that costs more is a loss).
- `costing`: FIFO, LIFO, average; cost of what is issued, what stays, shortages named.
- `payroll`: gross to net and net to gross; the rates are inputs (defaults: income tax 12, employee INPS 0.1, employer social 12) and are reported back.
- `landed_cost` (GTD): customs value at the declaration's rate, freight and insurance shared by value or weight, duty, excise, customs fee, import VAT apart (or in the cost when not recoverable), cost and unit cost by item.
- `penalty`: per day on a principal for days or dates, with a cap.
- `ratios`: liquidity, turnover days, margins, returns, cover, from the figures given.
- `break_even`: units and revenue, and for a target profit.
- `allocate`: any total shared by weights, to the cent.

The tool's input is checked by operation; a missing field comes back by name so the model corrects it.

## Left to the model, with the rules it works by

The prompt (`apps/api/src/ai/prompt.ts`, "Working like a senior accountant") gives the method (understand, use the
company's practice, read little, calculate with the tool, check, report assumptions), the frameworks (НСБУ and IFRS),
tax work, import, terminals, month and year end, analysis and audit procedures. It must say what it assumed, never
present a rate or deadline of the law as certain when it may have changed, and never invent a figure, an account
or a counterparty.

## Big jobs: a year of Didox documents, corrections

- **Receipts by the program, not by the model.** `propose_didox_invoices` builds the receipt and its received invoice
  for every document (invoices), and a receipt of services only for an act that has no invoice. Units, quantities and
  prices are the supplier's lines'; the unit is never a guess.
- **A VAT rate the base lacks** (a base set to 15% asked to take 2024's 12% documents) is found before any write:
  `VAT_RATE_MISSING` names the rates the base has, the accountant decides once, and `vatRateMap` writes the lines under
  the chosen rate with the supplier's own VAT amount.
- **Ledger accounts** by kind (`accounts`: goods, service) and by words in the line's name (`accountRules`, e.g. rent
  → 9410, goods for resale → 2910); PlatformAPI 0.7.5 sets the line's account (`account`) from the code.
- **Standing rules** (`company_rules`): what the accountant decides for the company in general is kept, sent with
  every question and followed without asking again.
- **Months found among years**: the Didox list is read with the document's own date, so a month in 2024 is found
  behind everything issued since, and what lies outside the period does not use up the limit.
- **A step cap** (60 per question) and a recipe in the prompt: correct by deleting the wrong documents and entering them
  again with the tool and the right rules, not by editing one by one; stop exploring after about eight steps without a write.

## The engine's own database (seeded), so the model is only the small part

The work is split in tiers, the cheapest that can do it first:

1. **Seeded template library** (`packages/shared/src/seed-templates.ts`, put into the table when the server starts; an admin's
   edits are kept, an untouched seed follows the code). About 22 everyday questions in Russian, Uzbek and English, answered by
   a fixed 1C query and rendered by the program, **no model, no cost**: cash and bank balances, balance of any account,
   receivables and payables by counterparty, a counterparty's balance, stock balances, revenue, cost of sales, period
   expenses, sales and purchases by counterparty and in total, bank receipts and payments, unposted documents, documents
   marked for deletion, duplicate receipts, currency rates. Matching is strict (every word of one phrase and no other
   meaningful word), a query a configuration does not accept falls back to the model, every answer has "Ask AI anyway".
2. **Program workflows**: bank statements, taxes, terminals, Didox receipts and sales (see above).
3. **Knowledge and arithmetic tools**: `accounting_knowledge` (`packages/shared/src/knowledge.ts`) gives typical entries,
   formulas, procedures (month-end, VAT reconciliation with Didox, stock count, audit by query, bank reconciliation) and
   the tax reference in a few lines, found by the words of the question, with the account groups checked against **this
   base's chart**; `accounting_calc` does the arithmetic.
4. **Learned, not guessed**: the policy now carries **how the company books each kind of document** (the account pairs of
   its entries, last 12 months), so entries are copied from its own books.
5. **The model**: only what has no rule, with a **cost stop** (60 steps, 40 reads of 1C per question) so that nothing can
   run for an hour and use the day's limit.

The engine also learns new templates from finished questions (existing); the seed gives it a start on day one.

## Knowing the task before searching (`router.ts`)

A short message names a task but often not its object. A bare "проведи" / "proveden" / "o'tkaz" / "post them" used to
go to the model as it was, and the model searched all of 1C and Didox for what might need posting. Now the program
settles it first, with no model step:

1. **This chat made documents and left them unposted** (`chat.created`): the posting card is made at once.
2. **It made none**: one read (the seeded "unposted documents" query over the last two months) and the answer is a
   numbered list: _1. all unposted (15) · 2. only «Поступление…» (12) · 3. only «Реализация…» (3) · 4. another period or
   kind — say which_. The answer "2", "all", "да", "hammasi" or a word of the kind picks it (`readChoice`); the program
   then finds those documents and puts them on one card. Options expire after six hours; any other message drops them.
3. **Any other message** goes to the model with a "State of this chat" line (documents created and unposted, Didox
   documents and files in the chat), and the prompt rule _know the task before you read anything_: a message that names
   a task but not its object is answered by ONE question with 2–4 numbered options, never by a search of 1C and Didox;
   a question about 1C documents does not start with Didox, nor the reverse.

A message that names an object, a period, a counterparty or a number ("проведи реализации за сентябрь") is a real
request and goes to the model as before.

## Why entering a year of Didox took an hour, and what was done

A real session (Didox 2024 in Uzbek Cyrillic) took ~63 minutes: dozens of model steps at about a minute each, a read of
the whole year of Didox again at each step, and receipts that 1C would not post rebuilt step by step. Fixed:

- **The import effort is sticky.** `ENTRY_WORDS` knows Uzbek Cyrillic and Latin (дидок…, кўчирма, ҳисоб-фактура,
  кирит…) and, once a chat begins entering documents (a word or a file), `chat.entry` keeps every follow-up message
  ("ҳа", "давом эт") at the cheap import effort — before, only the first message was.
- **"Post them" means documents.** A counterparty or an item made on the way is no longer in `chat.created`; the
  invoices the program builds itself (received, issued) are, so a bare «проведи» posts them.
- **A read of Didox is reused for five minutes** per company, direction and period (`readDidox`).
- **1C's own reasons for not posting.** PlatformAPI 0.7.6 returns `POST_FAILED` with the messages 1C gave the user (a
  missing balance, an empty field) instead of a bare "write failed", so the card and the model can fix the cause at
  once. Update PlatformAPI from the app (the update button) to get it.

- **Receipts that 1C will post (PlatformAPI 0.7.7).** The builder takes the header and the line accounts from the
  company's posted receipts (this supplier's first). In a base with none it used to leave them empty, and 1C refused
  to post. Now the technical fields get the form's usual defaults (multiplicity and rate 1, advance offset
  "Автоматически", the contract's currency or 860, the only warehouse, settlement accounts from the contract or the
  standard 6010/4310), and the result says which were guessed (`defaults`). Right after saving, 1C's own
  `ПроверитьЗаполнение` runs and what it finds unfilled comes back as `notReady`; the card shows
  «NOT READY TO POST: …» and the model fixes the named fields in one card before «проведи». Line accounts are never
  guessed: they come from the company's earlier documents, `accountRules`, or are named by `notReady`.

## Engine first, model last (`engine-tasks.ts`)

A request the program can do is done by the program, with no model call and no tokens:
a bank statement, Didox receipts and sales, currency rates, balance and revaluation checks,
and a VAT or payroll figure asked in plain words. The answer is written in the accountant's
language (Uzbek, Russian, English). The model is called only for what the program cannot decide.

When the model is not available (`AI_BUDGET_EXCEEDED`, `AI_USER_DAILY_LIMIT`, `AI_QUESTIONS_LIMIT`,
`AI_DAILY_LIMIT`, `AI_QUOTA_EXCEEDED`, `AI_NOT_CONFIGURED`, `AI_OUT_OF_SERVICE`, `AI_PROVIDER_BILLING`,
`AI_UNAVAILABLE`) the question is answered from the knowledge base (`offlineAnswer`) instead of an error,
and the jobs above keep working unchanged.

Cost of the model steps that remain: a step is sent the earlier questions as question and answer only
(`history.ts`); tool calls, results and thinking of earlier questions are dropped from what is sent
(the stored chat is untouched), so a step costs the same on the hundredth question as on the second.

## The engine plan (PDF «Buxgalteriya dvigateli — To'liq qurish rejasi») and what is built

| Plan                      | Module                                                                       | In the code                                                                                               | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Foundations            | PlatformAPI, counterparty/INN, rates, dry-run                                | `PlatformAPI`, `bank/`, `currency/`, confirmation cards                                                   | existed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P2 Decision centre        | `posting_rules`, five-step account choice, `operations` journal, corrections | `engine/posting-rules.ts`, `engine/journal.ts`, tool `posting_rules`, `LocalStore` (`engine` per company) | rule table (the plan's eight rows and the profit tax accrual) and the ladder built; the company's decisions are kept (`posting_rules set`, refused when the chart lacks an account) and the change is journaled as a correction; every job the program does is journaled. **Where the table decides:** the entries the program proposes itself (tax accrual) and, once the accountant has set a `purchase_goods` rule, the default account of received goods in Didox receipts. Documents copied from the company's own earlier documents (bank, sales, transfers) keep the account 1C books them with: the copy is the better source |
| P3 Tax                    | rates, benefits, profile, `tax.vat/turnover/accrue/calendar/registers`       | `engine/tax-tables.ts`, `engine/tax-accrual.ts`                                                           | VAT, profit, income, social, INPS rates by date; turnover tax has no rate in the table (asked of the adviser, never guessed); profit tax to accrue with the entry; VAT position by month from accounts 6410/4410; calendar of deadlines; 1C VAT registers against Didox. Every seeded rate and deadline is `approved: false` and the answers say so                                                                                                                                                                                                                                                                                   |
| P4 Receipts / sales       | Didox, ESF, documents                                                        | `didox/`, `propose_didox_*`                                                                               | existed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P5 Stock                  | `stock.balance/check/cost/transfer/writeOff/semiFinished`                    | `engine/financial.ts`, `engine/stock-moves.ts`, `engine/stock-cost.ts`, tool `stock_movement`             | balance and checks; transfer and write-off with a check of every line against the balance, the document built from the base's own field names and shown on one card; the cost of an item's issues checked against the company's method (the accountant names it; never chosen); semi-finished balance (off when there is no production). `stock.receive` and `stock.issue` are the Didox receipts and sales; `stock.produce` (release of production from a bill of materials) is not built                                                                                                                                            |
| P6 Bank                   | `bank.import/classify/currency/internal/terminal/buildDocuments/reconcile`   | `bank/`, `engine/bank-reconcile.ts`                                                                       | the statement's closing balance against 1C's balance of that bank account (soums, or the currency of the account)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P7 Financial result       | `result.*`                                                                   | `engine/financial.ts`, `engine/explain.ts`                                                                | revenue → net profit with the accounts of each line; what moved it, by the first analytic of the account, against the period before                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P8 Balance                | `balance.*`                                                                  | `buildBalance`, `buildDebts`, `engine/aging.ts`                                                           | 1-shakl, the checks, debts by counterparty, aging by FIFO (0–30, 31–60, 61–90, over 90 days) with advances apart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P9 Decision centre in use |                                                                              | `engineRoute` in `assistant.ts`                                                                           | the jobs above are answered with no model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| P10 Screens               |                                                                              | `renderer/src/screens/Reports.tsx`                                                                        | a Reports screen: company, report, period or day; tables, CSV for Excel, the same in words                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Reports are asked in the chat in plain words, and the model is not called: «2024 yil moliyaviy natijasi», «foyda nega kamaydi»,
«2024-12-31 holatiga balans», «debitorlik», «muddati o'tgan debitorlik», «ombor qoldig'i», «soliqlarni hisobla 2026 yil», «soliq
kalendari», «Didox bilan 1C ni solishtir», «ko'chirma qoldig'ini 1C bilan solishtir» (also in Russian and English). The model's
tools are `financial_report`, `stock_movement` and `posting_rules`.

How the reports read 1C (`engine/reports.ts`): the balances from `РегистрБухгалтерии.Хозрасчетный.Остатки`, the turnovers from
the register's entries (`СчетДт`, `СчетКт`, `Сумма`, `Период`, `Активность`), debts, aging and stock by the first analytics, the
VAT registers from `Документ.СчетФактураПолученный` / `СчетФактураВыданный` with the incoming number, date and amount found from
the object's description. Accounts of three digits or fewer are off-balance and are left out; the accounts are read by their group
(first two digits) of the NSBU chart. **These queries are not yet verified on a real base**: a field a configuration names
differently comes back as 1C's own message in the answer, not as an empty report. The transfer and write-off documents
(`Документ.ПеремещениеТоваров`, `Документ.СписаниеТоваров`) are built the same way: a field the base does not have is named with the
fields it does have.

### Trying it on a real base (the laptop)

1. «2024 yil moliyaviy natijasini ko'rsat»: compare revenue, cost and net profit with 1C's «Финансовые результаты».
2. «2024-12-31 holatiga balans ko'rsat»: assets and liabilities against 1C's balance; the line "Balans tengligi" must say it closes.
3. «debitorlik qarzlarini ko'rsat», «kreditorlik qarzlarini ko'rsat»: against the account cards 40xx / 60xx.
4. «ombor tovar qoldig'ini ko'rsat»: against the stock turnover-balance statement.
5. «1 000 000 so'm dan QQS hisobla»: 12%, with the note that the table is not yet confirmed.
6. «soliqlarni hisobla 2026 yil», «soliq kalendari»: profit tax and VAT against the declarations; the deadlines are a seed to be confirmed.
7. «muddati o'tgan debitorlik»: the ages against the account cards 40xx.
8. The Reports screen (left menu): the same reports as tables, and «Save as CSV».

## Not done

- Tax payments for quarterly or yearly taxes keep the template's period unless the purpose names one.
- Pairing the two legs of a conversion between a soum and a currency account (different amounts, a rate) to enter it as a conversion document: it is reported with the reason.
- Verified only against a fake 1C: the defaults of 0.7.7 and `ПроверитьЗаполнение` need the first real run.
- Everything that copies the company's earlier documents (transfers, conversions in soums, sales, currency payments) was verified against a fake 1C: the attribute names of the real configuration decide the first real run.
