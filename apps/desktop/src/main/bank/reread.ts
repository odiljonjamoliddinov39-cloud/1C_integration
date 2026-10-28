/**
 * Statements of the same bank account that overlap (a second file with the same period, a file given twice, a longer one that
 * holds the shorter one): a row met a second time is the same row, not a new one. The first file keeps it; the later file's copy is
 * left out and told, so that nothing is read twice and nothing is written twice. Two equal rows inside one file are two payments
 * (twins) and stay; a later file takes away at most as many copies as the earlier files hold.
 */
import type { BankPayment, BankStatement } from "./statement.js";

export interface Repeat {
  file: string;
  row: number;
  /** The row of the earlier file this one repeats. */
  firstFile: string;
  firstRow: number;
}

const digits = (s: string) => s.replace(/\D/g, "");
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Everything a row says: the same payment in two files agrees on all of it. */
const identity = (p: BankPayment) =>
  [
    p.date.slice(0, 10),
    p.direction,
    Math.round(p.amount),
    digits(p.account),
    norm(p.number),
    norm(p.purpose),
  ].join("|");

export function rereadStatements(statements: BankStatement[]): {
  statements: BankStatement[];
  repeats: Repeat[];
} {
  const repeats: Repeat[] = [];
  // Rows kept so far, by account and by what they say.
  const seen = new Map<string, Map<string, { file: string; row: number }[]>>();
  const out = statements.map((s) => {
    const account = digits(s.account);
    if (!account) return s;
    const earlier = seen.get(account) ?? new Map<string, { file: string; row: number }[]>();
    const kept: BankPayment[] = [];
    const mine = new Map<string, { file: string; row: number }[]>();
    // Each file is set against what all the earlier files hold: a row three files carry is the first file's twice over.
    const open = new Map([...earlier].map(([key, list]) => [key, [...list]]));
    for (const p of s.payments) {
      const key = identity(p);
      const first = open.get(key)?.shift();
      if (first) {
        repeats.push({ file: s.fileName, row: p.row, firstFile: first.file, firstRow: first.row });
        continue;
      }
      kept.push(p);
      mine.set(key, [...(mine.get(key) ?? []), { file: s.fileName, row: p.row }]);
    }
    // What this file kept that no earlier file held is what a later file can repeat.
    for (const [key, list] of mine) earlier.set(key, [...(earlier.get(key) ?? []), ...list]);
    seen.set(account, earlier);
    return kept.length === s.payments.length ? s : { ...s, payments: kept };
  });
  return { statements: out, repeats };
}

/** One line for the model, and for the accountant behind it: what was met twice and how it was handled. */
export function describeRepeats(repeats: Repeat[]): string {
  if (repeats.length === 0) return "";
  const byFile = new Map<string, number>();
  for (const r of repeats) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
  const files = [...byFile].map(([file, n]) => `${file}: ${n}`).join("; ");
  const examples = repeats
    .slice(0, 5)
    .map((r) => `${r.file} row ${r.row} = ${r.firstFile} row ${r.firstRow}`)
    .join("; ");
  return `${repeats.length} rows were met a second time in overlapping statements of the same account (${files}); each is the same row as the earlier file's (${examples}), so it was read and is entered once.`;
}
