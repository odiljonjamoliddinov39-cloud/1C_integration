# How the company works: learned from its own 1C

The assistant does not work from general accounting rules alone. For each company it **learns the company's own
practice from 1C** (read only, no AI, a score of queries) and sends it with every question, so every task - a bank
statement, an invoice, an audit, an answer to "how do we book this?" - follows the way this company actually works.

## What is learned (`apps/desktop/src/main/bank/policy.ts`)

| What                                                         | Where it is read from                                                                                                                                                                                                            | What it tells                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Bank accounts of the company                                 | `Справочник.БанковскиеСчета` (number, name, currency, `СчетБУ`; the company's own by owner INN)                                                                                                                                  | Which account is the main one, which is blocked (by its name), which is in a currency         |
| What each account is used for                                | `ВидОперации` of `СписаниеСРасчетногоСчета` / `ПоступлениеНаРасчетныйСчет`, grouped by account                                                                                                                                   | Kinds of operation per account, how many, first and last date                                 |
| How it books money between its own accounts, and conversions | the kinds above that read as a transfer / conversion / currency purchase                                                                                                                                                         | The document the company uses for such money, or that it never recorded any                   |
| What the company does                                        | posted documents of the last 12 months (sales, purchases, invoices, cash, journal entries, imports…)                                                                                                                             | Which kinds of work are real here                                                             |
| Ledger accounts in use                                       | `РегистрБухгалтерии.Хозрасчетный`, top debit and credit accounts of the last 12 months                                                                                                                                           | The company's chart in practice                                                               |
| Currency practice                                            | currency of `ДоговорыКонтрагентов`                                                                                                                                                                                               | How much is in USD/RUB                                                                        |
| The accounting policy itself                                 | the first of `РегистрСведений.УчетнаяПолитикаОрганизаций`, `…УчетнаяПолитика`, `…УчетнаяПолитикаБУ`, `…ПараметрыУчетнойПолитики`, `Справочник.УчетныеПолитики` that the configuration has: the newest record's settings by title | The settings the accountant set (VAT, valuation…), when the configuration has such a register |

Each read may fail without stopping the others; what could not be read is listed in the text ("Not read: …"). A base
that answers nothing gives no text at all, and the question goes on without it.

## How it is used

- **Every model turn** (chat and audit checks) carries the text as `policy` in the request; the server puts it in the
  system prompt after the structure digest, cached, with the instruction to follow the practice, to say where it is
  silent, and to mention where the practice differs from a general rule.
- It is **kept per company for 6 hours** and shared by questions asked meanwhile; a slow base is waited for at most
  20 s. The tool `learn_accounting_policy` (no input) re-reads it on demand and returns it: use it for "how do we
  book…" questions.
- **Bank import** (`propose_bank_payments`) sets the statements against it (`reflectOnImport`): an account the
  statement has that 1C does not, a currency that disagrees, and how 1C books the transfers and conversions the
  import found. The program enters the transfers (`bank/transfer.ts`): see `docs/bank-statements.md`.

## Not done yet

A policy stored on the server between sessions.
