/**
 * The bank's closing balance against 1C's (bank.reconcile): for each statement that prints its closing balance, the
 * balance 1C holds on that bank account at the statement's last day. A foreign-currency account is compared in its
 * currency; the account number says which (digits 6–8: 000 is soums).
 */

export interface StatementBalance {
  fileName: string;
  /** The account number the statement is for. */
  account: string;
  /** The last day of the statement (YYYY-MM-DD). */
  date: string;
  /** The closing balance in the account's own units (soums, or the currency). */
  closing: number | null;
}

export interface BookBalance {
  account: string;
  soum: number;
  currency: number;
}

export interface ReconcileRow {
  fileName: string;
  account: string;
  date: string;
  statement: number | null;
  inBooks: number | null;
  difference: number | null;
  status: "match" | "difference" | "not_in_1c" | "no_balance";
}

const digits = (s: string) => s.replace(/\D/g, "");
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The ISO currency code the account number carries, or null for soums. */
export function accountCurrency(account: string): string | null {
  const code = digits(account).slice(5, 8);
  return code === "000" || code.length < 3 ? null : code;
}

export function reconcileBank(
  statements: StatementBalance[],
  books: BookBalance[],
  tolerance = 0.01,
): { rows: ReconcileRow[]; allMatch: boolean } {
  const byAccount = new Map<string, BookBalance>();
  for (const b of books) {
    const key = digits(b.account);
    const known = byAccount.get(key);
    byAccount.set(
      key,
      known ? { account: b.account, soum: known.soum + b.soum, currency: known.currency + b.currency } : b,
    );
  }
  const rows = statements.map<ReconcileRow>((s) => {
    const base = { fileName: s.fileName, account: s.account, date: s.date };
    if (s.closing === null)
      return { ...base, statement: null, inBooks: null, difference: null, status: "no_balance" };
    const book = byAccount.get(digits(s.account));
    if (!book) return { ...base, statement: s.closing, inBooks: null, difference: null, status: "not_in_1c" };
    const inBooks = round2(accountCurrency(s.account) ? book.currency : book.soum);
    const difference = round2(s.closing - inBooks);
    return {
      ...base,
      statement: s.closing,
      inBooks,
      difference,
      status: Math.abs(difference) <= tolerance ? "match" : "difference",
    };
  });
  return { rows, allMatch: rows.length > 0 && rows.every((r) => r.status === "match") };
}
