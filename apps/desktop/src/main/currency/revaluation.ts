/**
 * The month-end revaluation of currency balances, worked out by the program: for each currency account (and each
 * currency settlement account, such as an advance in dollars) at each month's end, what the balance in soums should be
 * at the Central Bank's rate of that day, against what 1C carries. 1C does the revaluation itself in its
 * «Закрытие месяца → Переоценка валютных средств» (a regulated operation, not a document this app can create); this
 * says what that operation has to produce, and after it has run, whether it did: the differences are zero.
 */

export interface CurrencyBalance {
  account: string;
  currency: string;
  /** Debit minus credit, in the currency. */
  currencyNet: number;
  /** Debit minus credit, in soums. */
  soumNet: number;
}

export interface Revaluation {
  month: string;
  date: string;
  account: string;
  currency: string;
  currencyNet: number;
  soumNet: number;
  rate: number;
  /** What the balance in soums should be at the rate. */
  expected: number;
  /** To add to the debit side of the account (negative: to the credit side). */
  adjustment: number;
  entry: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The last day of each month from the one holding `from` to the one holding `to`. */
export function monthEnds(from: string, to: string): string[] {
  const out: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const last = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
  while (year * 12 + month <= last && out.length < 36) {
    out.push(new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10));
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

export function revalue(
  date: string,
  balances: CurrencyBalance[],
  rateOn: (currency: string) => number | null,
  tolerance = 1,
): { found: Revaluation[]; noRate: string[] } {
  const found: Revaluation[] = [];
  const noRate = new Set<string>();
  for (const b of balances) {
    if (!b.currency || b.currency === "UZS") continue;
    if (Math.abs(b.currencyNet) < 0.005 && Math.abs(b.soumNet) < tolerance) continue;
    const rate = rateOn(b.currency);
    if (rate === null) {
      noRate.add(b.currency);
      continue;
    }
    const expected = round2(b.currencyNet * rate);
    const adjustment = round2(expected - b.soumNet);
    if (Math.abs(adjustment) < tolerance) continue;
    found.push({
      month: date.slice(0, 7),
      date,
      account: b.account,
      currency: b.currency,
      currencyNet: round2(b.currencyNet),
      soumNet: round2(b.soumNet),
      rate,
      expected,
      adjustment,
      entry:
        adjustment > 0
          ? `Дт ${b.account} / Кт 9540 (exchange gain) ${adjustment}`
          : `Дт 9620 (exchange loss) / Кт ${b.account} ${-adjustment}`,
    });
  }
  return { found, noRate: [...noRate] };
}
