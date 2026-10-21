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

## Not done

- Tax payments for quarterly or yearly taxes keep the template's period unless the purpose names one.
- Pairing the two legs of a conversion between a soum and a currency account (different amounts, a rate) to enter it as a conversion document: it is reported with the reason.
- Everything that copies the company's earlier documents (transfers, conversions in soums, sales, currency payments) was verified against a fake 1C: the attribute names of the real configuration decide the first real run.
