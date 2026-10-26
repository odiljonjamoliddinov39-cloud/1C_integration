# Customs declaration (GTD): reading, checking and posting

Implements the spec «GTD (customs declaration) reading and posting». Code: `apps/desktop/src/main/gtd/`; tool `gtd_declaration`.

## The idea

A declaration is read in two halves, so no number is trusted just because a model read it:

1. **The program reads the clean text** of the PDF (no model): the footer of every page
   («Copy / 26003 / 04.11.2025 / 0090704. 3/ 12»: the declaration and the sheet, `pages.ts`) and the item texts of the back pages
   (graph 31: «Item No. N», then «1. English/Russian …», split at the first «/»). The text layer comes from `pdfjs-dist`
   (`pdf-text.ts`). A PDF is found to be a declaration by its footer (`attachments.ts`); the PDF still goes to the model, with a
   note telling it what the program has already read.
2. **The model reads the numbers** of the form pages (TD-1 and every TD-2: scans with a broken text layer) and passes them to
   `gtd_declaration` (`GtdReadInput` in `packages/shared/src/ai.ts`). A graph the scan does not show is `null`, never guessed.

Everything after that is the program's: the regime, every check, the allocation, the proposal and the text of the report. The
numbers in the assistant's answer are the program's numbers.

## Order of the work (`run.ts`)

1. **Regime first** (`regime.ts`). IM 74 is the customs warehouse; IM 40 the release for consumption, or the release _from a
   warehouse_ when graph 40 names an IM 74 declaration this company has read (`registry.ts`, kept per company in the store).
   Any other code, or a non-import, stops with a question and no amount is shown.
2. **Importer's INN (V8)** is judged before anything else is shown: another company's declaration is not shown at all.
3. **Rules V1–V12** (`validate.ts`). A failed rule blocks the run and comes back with the two numbers that disagree:
   `checks_failed` when the slip may be the scan's (the model re-reads the named sheets once and calls again with `retry`),
   `needs_user` when only the accountant can settle it (a missing sheet, another company, no contract in 1C, no exchange rate)
   or when the second reading failed again. Nothing is proposed or posted on a failed rule.
4. **Proposal** (`proposal.ts`, `allocate.ts`, `onec.ts`).

| Rule | What it judges                                                                               |
| ---- | -------------------------------------------------------------------------------------------- |
| V1   | footer sequence 1/N … N/N has no gap (a missing sheet is named)                              |
| V2   | item numbers (graph 32) run 1..N with no gap or repeat, N = graph 5                          |
| V3   | sum of item values (graph 42) = invoice amount (graph 22), to 0.01                           |
| V4   | invoice × rate (graph 23) = customs value = base of the declaration-level fee/duty line      |
| V5   | every HS code has exactly 10 digits                                                          |
| V6   | net weight ≤ gross weight on every item                                                      |
| V7   | every item has the procedure of graph 1                                                      |
| V8   | importer's INN = the INN of the company selected in the app                                  |
| V9   | fee = multiplier × base calculation value (BRV) of the declaration's date                    |
| V10  | statistical value (graph 46) ≈ item value / 1000 (USD invoices)                              |
| V11  | IM 74 only: graph 49 and the deadline of graph 50 are present and after the declaration date |
| V12  | the contract (graph 44, code 202) is in 1C under this supplier                               |

Warnings do not block: **W1** HS code against the description (a short curated table with a reason for each entry, plus the
same description under two codes), **W2** used goods («Б/у», «Used»: separate nomenclature), **W3** repeated descriptions (one
line per item number, never merged), **W4** a missing exchange rate (never filled from the central bank), and the reading notes
(a number that is not a number, pages of another declaration, the footer against the form's header, a BRV the table lacks).

Money is exact: `decimal.ts` keeps amounts as whole units over a power of ten, nothing is a float. Tolerance is 0.01.

## The proposal for IM 74

Only the fee is posted. Duty, excise and import VAT are deferred while the goods are in the warehouse; the proposal has no VAT or
duty entry, and a duty or VAT line printed on an IM 74 declaration is listed as _excluded_, not posted.

| Step | Entry                                             | Status                                                            |
| ---- | ------------------------------------------------- | ----------------------------------------------------------------- |
| 1    | goods from the foreign supplier                   | the existing flow (the receipt), not written from the declaration |
| 2    | fee: Dt cost of the goods / Kt customs settlement | shared over the items by value (below)                            |
| 3    | payment of the fee from the bank                  | comes from the bank statement (the 29801 prefix)                  |
| 4    | import VAT and duty                               | **no posting**                                                    |

**Allocation** (`allocate.ts`): `fee_i = fee × value_i / total value`, each rounded to 0.01 and the rounding remainder put on the
item with the largest value, so the shares add up to exactly the fee (item 1 of the sample: 376 568.00; item 2: 94 760.00). A
charge on an item's own TD-2 sheet belongs to that item alone.

**Accounts** are never invented. `onec.ts` reads the posted entries of the last year: the account that took the payments to the
customs is the customs settlement account (and the bank account they left from); the accounts of the supplier's earlier receipts
are where the goods are kept and the foreign supplier settlements. A role the base does not show stays open: the entry is marked
`confirm`, and the spec's 2910 is named only as what is expected, not used. After the accountant confirms, only entries marked
`ready` are written; for one marked `confirm` the assistant asks which account, naming a posted example.

## What is not coded, and why

- **IM 40 postings** (duty, excise, fee, import VAT 12 % on (customs value + duty + excise); the release from a warehouse with
  partial releases and the remaining quantity per item) wait for a second sample (spec §9, step 7). An IM 40 is read, checked and
  linked to its IM 74 declaration; its proposal says it is not posted.
- **How the postings are written to 1C** is open (which document the base uses for the customs fee). The tool proposes; the
  assistant writes the confirmed entries through the ordinary change card.
- **Open decisions** the report repeats to the accountant: that code 74 is the customs warehouse in the official classifier; how
  IM 74 goods are kept apart in 1C (a warehouse or a batch attribute); which exchange rate is the cost base and where the
  difference goes.
- The base calculation value known to the program is the one of the sample's date (412 000 on 04.11.2025); for any other date V9
  judges the arithmetic and the BRV the declaration states, and a warning says the BRV is not confirmed.
- The sample's graph 6 (places) is not read; gross weights are read like any number.

## Tests

`gtd/*.test.ts` hold the spec's acceptance tests on a 32-item fixture of the sample (`fixture.ts`): 1 happy path, 2 no VAT on
IM 74, 3 allocation, 4 an OCR slip (item 13: 1 174 → 1 147, V3 fails and names the difference of 27), 5 wrong company, 6 a missing
sheet, 7 an unsupported regime. The gross weights, the Russian names after item 1 and the settlement accounts of the test base
are made up in the fixture. `attachments.test.ts` and `assistant.test.ts` cover the PDF found among attachments and the tool
end to end.
