/**
 * The list a bank import would enter, shown before anything is written: each line with the kind the program read it as, the
 * rule that read it and the 1C document it would become. It is made from the statements alone (no 1C call, no write), so it
 * answers "show me the list first" and "only the taxes" without a card to approve.
 */
import type { Classified, Unclassified } from "./classify.js";
import type { BankPayment, BankStatement } from "./statement.js";

/** Lines shown in one preview; the counts always cover all of them. */
export const PREVIEW_LINES = 200;

export interface PreviewTask {
  statement: BankStatement;
  rows: number[];
  currency: string;
}

/** The 1C document a line of this kind and direction is entered as (the operation and accounts are the company's own, copied). */
export function documentOfLine(kind: string, direction: "in" | "out"): string {
  const object = direction === "in" ? "Поступление на расчетный счет" : "Списание с расчетного счета";
  if (kind === "tax" && direction === "out") {
    return `${object}, operation «Уплата налога» (copied from the company's latest posted payment of the same tax)`;
  }
  return object;
}

/** Is the line of one of the kinds asked for? With no kinds, every line is. */
export function rowIsOfKind(
  classes: Map<number, Classified>,
  row: number,
  kinds: Set<string> | null,
): boolean {
  if (!kinds) return true;
  const type = classes.get(row)?.type;
  return type !== undefined && kinds.has(type);
}

const money = (tiyin: number) => (tiyin / 100).toFixed(2);

export function previewOfBank(
  tasks: PreviewTask[],
  classes: Map<string, Map<number, Classified>>,
  held: Unclassified[],
  ownTransfers: number,
  kinds: Set<string> | null,
) {
  const lines: Record<string, unknown>[] = [];
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const { statement, rows, currency } of tasks) {
    const byRow = new Map<number, BankPayment>(statement.payments.map((p) => [p.row, p]));
    for (const row of rows) {
      const p = byRow.get(row);
      const c = classes.get(statement.fileName)?.get(row);
      if (!p || !c) continue;
      total += 1;
      byKind[c.type] = (byKind[c.type] ?? 0) + 1;
      if (lines.length < PREVIEW_LINES) {
        lines.push({
          file: statement.fileName,
          row,
          date: p.date,
          direction: p.direction,
          amount: money(p.amount),
          currency: currency || "UZS",
          counterparty: p.counterparty.replace(/\s+/g, " ").trim().slice(0, 60),
          purpose: p.purpose.replace(/\s+/g, " ").trim().slice(0, 140),
          kind: c.type,
          confidence: c.confidence,
          rule: c.rule,
          document: documentOfLine(c.type, p.direction),
        });
      }
    }
  }
  return {
    status: "preview",
    wrote: "nothing: no document was made or changed in 1C",
    ...(kinds ? { onlyKinds: [...kinds] } : {}),
    about:
      "Show the accountant this list (count, kinds, the 1C document of each) and wait for their word. Entering is a second call " +
      "without preview; the documents are left unposted, copied from the company's own earlier ones.",
    count: total,
    byKind,
    lines,
    ...(total > lines.length
      ? { shown: lines.length, note: `only the first ${lines.length} lines are listed; the counts cover all` }
      : {}),
    ...(held.length > 0
      ? {
          notEnteredBecauseUncertain: {
            count: held.length,
            note: "The kind of these lines is not certain: they would NOT be written; the accountant decides.",
            examples: held.slice(0, 20),
          },
        }
      : {}),
    ...(ownTransfers > 0
      ? {
          transfersBetweenOwnAccounts: ownTransfers,
          transfersNote: "entered as pairs of documents, one on each account",
        }
      : {}),
  };
}
