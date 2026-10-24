/**
 * A currency conversion, found in the statements by the bank's own words. The bank writes both legs of a purchase or a
 * sale of currency with the same text: «Конвертация валютных средств 4165.0 'Доллар США' по курсу 12484.0». So the two
 * legs are paired by what they say (the currency, the amount in it, the rate, the day), not by guessing from amounts of
 * two currencies:
 *
 *   buy:  the soum account pays 51 995 860, the dollar account takes in 4 165   (4 165 × 12 484 = 51 995 860)
 *   sell: the dollar account pays 6 080, the soum account takes in 76 583 680   (6 080 × 12 596 = 76 583 680)
 *
 * A conversion is one thing with two linked legs and a number (its id): the engine writes both or none, and the money
 * passes through the conversion (transit) account, which must close to zero (see build.ts). A leg whose partner is not
 * in the attached statements is not paired and is left to the accountant.
 */
import { currencyOfAccount } from "./ledger.js";
import type { BankPayment, BankStatement } from "./statement.js";

export interface FxText {
  /** The amount of currency, in units. */
  amount: number;
  /** ISO letters ("USD"). */
  currency: string;
  /** Soums per unit, as the bank wrote it. */
  rate: number;
}

export interface Leg {
  file: string;
  row: number;
  account: string;
  payment: BankPayment;
}

/** One conversion with both of its legs. */
export interface FxConversion {
  id: string;
  /** "buy": soums pay for currency; "sell": currency is sold for soums. */
  direction: "buy" | "sell";
  date: string;
  currency: string;
  /** The amount of currency, in units, and the bank's rate. */
  amount: number;
  rate: number;
  /** The soum leg and the currency leg. */
  soum: Leg;
  foreign: Leg;
}

const NAMES: [RegExp, string][] = [
  [/доллар|dollar|usd/i, "USD"],
  [/евро|euro|eur/i, "EUR"],
  [/рубл|rubl|rub/i, "RUB"],
  [/фунт|pound|gbp/i, "GBP"],
];

const number = (s: string) => Number(s.replace(/\s+/g, "").replace(",", "."));

/** What the bank's conversion text says: the amount of currency, which currency, and the rate. Null for any other text. */
export function fxText(purpose: string): FxText | null {
  const found =
    /конвертац\p{L}*\s+валютн\p{L}*\s+средств\s+(\d[\d\s]*(?:[.,]\d+)?)\s*(?:['"«]?\s*([\p{L}]+(?:\s+США)?)\s*['"»]?)?\s*по\s+курсу\s+(\d[\d\s]*(?:[.,]\d+)?)/iu.exec(
      purpose,
    );
  if (!found) return null;
  const amount = number(found[1] ?? "");
  const rate = number(found[3] ?? "");
  const currency = NAMES.find(([test]) => test.test(found[2] ?? ""))?.[1] ?? "";
  return Number.isFinite(amount) && amount > 0 && Number.isFinite(rate) && rate > 0 && currency
    ? { amount, currency, rate }
    : null;
}

const days = (a: string, b: string) =>
  Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86_400_000;

/** Same figure, as the bank writes it on two statements (one decimal more or less). */
const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.005, Math.abs(a) * 1e-9);

export interface Conversions {
  conversions: FxConversion[];
  /** "file#row" of every leg that belongs to a conversion. */
  consumed: Set<string>;
  /** Legs the bank wrote as a conversion whose other leg is not in the attached statements. */
  alone: Leg[];
}

export const legKey = (file: string, row: number) => `${file}#${row}`;

export function findConversions(statements: BankStatement[]): Conversions {
  const soum: { leg: Leg; fx: FxText }[] = [];
  const foreign: { leg: Leg; fx: FxText }[] = [];
  for (const s of statements) {
    const currency = currencyOfAccount(s.account);
    if (currency === "") continue;
    for (const p of s.payments) {
      const fx = fxText(p.purpose);
      if (!fx) continue;
      const leg: Leg = { file: s.fileName, row: p.row, account: s.account, payment: p };
      if (currency === "UZS") soum.push({ leg, fx });
      else if (currency === fx.currency) foreign.push({ leg, fx });
    }
  }
  const conversions: FxConversion[] = [];
  const consumed = new Set<string>();
  const taken = new Set<unknown>();
  for (const f of foreign.sort((a, b) => a.leg.payment.date.localeCompare(b.leg.payment.date))) {
    // A purchase: the soum account pays and the currency account takes in; a sale: the other way.
    const direction = f.leg.payment.direction === "in" ? "buy" : "sell";
    const wantSoum = direction === "buy" ? "out" : "in";
    let best: { s: (typeof soum)[number]; gap: number } | null = null;
    for (const s of soum) {
      if (taken.has(s) || s.leg.payment.direction !== wantSoum) continue;
      if (s.fx.currency !== f.fx.currency || !same(s.fx.amount, f.fx.amount) || !same(s.fx.rate, f.fx.rate))
        continue;
      if (!same(f.leg.payment.amount / 100, f.fx.amount)) continue;
      const gap = days(s.leg.payment.date, f.leg.payment.date);
      if (gap > 3) continue;
      if (!best || gap < best.gap) best = { s, gap };
    }
    if (!best) continue;
    taken.add(best.s);
    const date = [best.s.leg.payment.date, f.leg.payment.date].sort()[0] ?? f.leg.payment.date;
    conversions.push({
      id: `FX-${f.leg.payment.date}-${f.fx.currency}-${f.fx.amount}-${f.leg.payment.number || f.leg.row}`,
      direction,
      date,
      currency: f.fx.currency,
      amount: f.fx.amount,
      rate: f.fx.rate,
      soum: best.s.leg,
      foreign: f.leg,
    });
    consumed.add(legKey(best.s.leg.file, best.s.leg.row));
    consumed.add(legKey(f.leg.file, f.leg.row));
  }
  const alone = [...soum.map((x) => x.leg), ...foreign.map((x) => x.leg)].filter(
    (leg) => !consumed.has(legKey(leg.file, leg.row)),
  );
  return { conversions, consumed, alone };
}
