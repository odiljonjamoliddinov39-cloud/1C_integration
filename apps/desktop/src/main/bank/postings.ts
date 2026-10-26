/**
 * The bank documents that 1C has booked to the wrong account, and what to do with them. A bank document is booked on the bank's
 * side to the ledger account named in its «СчетБанк»: the one of its bank account's card (5110, 5530, 5210…). A document written
 * without the form carries the default, so the blocked-funds account stays empty and the settlement account takes its money.
 *
 *  - a document whose «СчетБанк» is not its bank account's ledger account: the attribute is set right and the document posted again;
 *  - a document of the operations «Перевод на другой счет» / «Перевод с другого счета» (written without the form they post to
 *    the wrong account or not at all) that a row of an attached statement stands behind: taken back, and entered again from
 *    the statement as «Прочее списание» / «Прочее поступление» through the transit account (see build.ts).
 */
import type { ChangeInput } from "@platform/shared";

import type { BankDoc } from "./duplicates.js";
import type { LedgerAccounts } from "./ledger-account.js";
import type { BankStatement } from "./statement.js";

const CHART = "ПланСчетов.Хозрасчетный";

/** The operations that are a move between the company's accounts as 1C's own form writes them. */
export const FORM_TRANSFER = /перевод\s+(?:на|с)\s+друг/iu;

export interface PostingFix {
  /** Documents to take back: moves written as the operation «Перевод…», each with a row of the statements behind it. */
  retire: BankDoc[];
  /** Documents whose bank ledger account is set right: the document, and the account it should have. */
  reledger: { doc: BankDoc; ledger: string; code: string }[];
  /** Documents on an account whose card names no ledger account: not touched. */
  unknownLedger: number;
}

const day = (iso: string) => iso.slice(0, 10);

export function findPostingFixes(
  statements: BankStatement[],
  docs: BankDoc[],
  ledger: LedgerAccounts,
  codeOf: (ref: string) => string = (ref) => ref,
): PostingFix {
  // Rows of the statements, to retire a move only when a row stands behind it (it can be entered again).
  const rows = new Map<string, number>();
  for (const s of statements) {
    if (!s.account) continue;
    for (const p of s.payments) {
      const key = `${s.account}|${p.direction}|${day(p.date)}|${Math.round(p.amount)}`;
      rows.set(key, (rows.get(key) ?? 0) + 1);
    }
  }
  const retire: BankDoc[] = [];
  const reledger: PostingFix["reledger"] = [];
  let unknownLedger = 0;
  for (const doc of docs) {
    if (FORM_TRANSFER.test(doc.kind)) {
      const key = `${doc.account}|${doc.direction}|${doc.day}|${doc.cents}`;
      const left = rows.get(key) ?? 0;
      if (left > 0) {
        rows.set(key, left - 1);
        retire.push(doc);
        continue;
      }
    }
    const own = ledger.byNumber.get(doc.account);
    if (!own) continue;
    if (!own.ledger) {
      unknownLedger += 1;
      continue;
    }
    if (doc.ledger !== own.ledger) reledger.push({ doc, ledger: own.ledger, code: codeOf(own.ledger) });
  }
  return { retire, reledger, unknownLedger };
}

/** The change that sets a document's bank ledger account right and posts it again when it was posted. */
export function reledgerChange(doc: BankDoc, attribute: string, ledger: string): ChangeInput {
  return {
    action: "update",
    object: doc.object,
    ref: doc.ref,
    fields: { [attribute]: { type: CHART, ref: ledger } },
    post: doc.posted,
  };
}
