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

## Not done

- Entering transfers between own accounts and currency conversions as 1C documents (they are reported with how 1C records them).
- A deterministic sale builder in the 1C extension (the sale is still made by the model from the kit).
- Tax payments for quarterly or yearly taxes keep the template's period unless the purpose names one.
