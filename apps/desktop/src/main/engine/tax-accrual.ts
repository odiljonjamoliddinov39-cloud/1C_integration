/**
 * What the taxes of a period come to, worked out by the program from the ledger and the tax tables: the profit tax to
 * accrue (tax.accrue), the VAT position by month, the turnover tax, the calendar of payments and reports, and the
 * comparison of the 1C VAT registers with Didox (tax.registers). Rates come from the tables by date and are never
 * written here; what the tables lack is asked for, not guessed. The entries it names are a proposal for the accountant:
 * nothing is posted by this module.
 */
import { type TaxProfile, type TaxRate, rateWithBenefits } from "./tax-tables.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

// --- Profit tax ----------------------------------------------------------------------------------------------------

export interface ProfitTaxAccrual {
  profitBeforeTax: number;
  rate: number;
  rateSource: string;
  approved: boolean;
  benefit?: string;
  /** The tax for the profit of the period. */
  due: number;
  /** Already accrued in the period (9810). */
  accrued: number;
  /** What is still to accrue; negative: accrued too much. */
  toAccrue: number;
  entry: { debit: string; credit: string; amount: number } | null;
  note: string;
}

export function accrueProfitTax(
  profitBeforeTax: number,
  accrued: number,
  date: string,
  profile: TaxProfile,
  tables: { rates?: TaxRate[] } = {},
): ProfitTaxAccrual | { error: string } {
  const found = rateWithBenefits("profit", date, profile, {}, tables);
  if (!found)
    return { error: `The profit tax rate for ${date} is not in the tax table: the tax adviser must add it.` };
  // A loss owes no tax; it is not carried here (the carry-forward rules are the adviser's).
  const due = round2(Math.max(0, profitBeforeTax) * (found.rate / 100));
  const toAccrue = round2(due - accrued);
  return {
    profitBeforeTax: round2(profitBeforeTax),
    rate: found.rate,
    rateSource: found.source,
    approved: found.approved,
    ...(found.benefit ? { benefit: found.benefit } : {}),
    due,
    accrued: round2(accrued),
    toAccrue,
    entry: toAccrue > 0.004 ? { debit: "9810", credit: "6410", amount: toAccrue } : null,
    note:
      profitBeforeTax <= 0
        ? "no profit in the period: no profit tax; any carried loss is for the tax adviser"
        : toAccrue < -0.004
          ? "more tax has been accrued than the profit gives: check the accrual (a reversal may be due)"
          : "the entry is a proposal: the accountant posts it",
  };
}

// --- VAT -----------------------------------------------------------------------------------------------------------

export interface VatMonth {
  month: string;
  /** VAT charged on sales (credit turnover of the VAT account). */
  output: number;
  /** VAT paid on purchases, to be offset (debit turnover of the offset account). */
  input: number;
  payable: number;
}

export interface VatPosition {
  months: VatMonth[];
  output: number;
  input: number;
  /** Positive: to pay; negative: to offset or refund. */
  payable: number;
  note: string;
}

export function vatPosition(rows: { month: string; output: number; input: number }[]): VatPosition {
  const map = new Map<string, { output: number; input: number }>();
  for (const r of rows) {
    const known = map.get(r.month) ?? { output: 0, input: 0 };
    map.set(r.month, { output: known.output + r.output, input: known.input + r.input });
  }
  const months = [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      month,
      output: round2(v.output),
      input: round2(v.input),
      payable: round2(v.output - v.input),
    }));
  const output = round2(months.reduce((a, m) => a + m.output, 0));
  const input = round2(months.reduce((a, m) => a + m.input, 0));
  return {
    months,
    output,
    input,
    payable: round2(output - input),
    note: "worked out from the VAT account's turnovers: check them against the VAT declaration; the account may also carry other taxes",
  };
}

// --- Turnover tax --------------------------------------------------------------------------------------------------

export function turnoverTax(
  revenue: number,
  date: string,
  profile: TaxProfile,
  tables: { rates?: TaxRate[] } = {},
):
  | { revenue: number; rate: number; tax: number; rateSource: string; approved: boolean; benefit?: string }
  | { error: string } {
  const found = rateWithBenefits("turnover", date, profile, {}, tables);
  if (!found)
    return {
      error: `The turnover tax rate for ${date} is not in the tax table: the rate depends on the activity and has changed, so the tax adviser must add it.`,
    };
  return {
    revenue: round2(revenue),
    rate: found.rate,
    tax: round2(Math.max(0, revenue) * (found.rate / 100)),
    rateSource: found.source,
    approved: found.approved,
    ...(found.benefit ? { benefit: found.benefit } : {}),
  };
}

// --- Calendar ------------------------------------------------------------------------------------------------------

export interface Deadline {
  id: string;
  tax: "vat" | "profit" | "income" | "social" | "inps" | "turnover";
  kind: "report" | "payment";
  frequency: "monthly" | "quarterly" | "annual";
  /** Day of the month the deadline falls on, `monthsAfter` months after the period ends. */
  day: number;
  monthsAfter: number;
  appliesTo?: { regime?: TaxProfile["regime"]; vatPayer?: boolean };
  source: string;
  approved: boolean;
}

const SEED = "seed of the program; the tax adviser confirms it against the Tax Code";

/** The dates are a seed, `approved: false`: the answers carry that until the adviser has confirmed each row. */
export const TAX_DEADLINES: Deadline[] = [
  {
    id: "vat-report",
    tax: "vat",
    kind: "report",
    frequency: "monthly",
    day: 20,
    monthsAfter: 1,
    appliesTo: { vatPayer: true },
    source: SEED,
    approved: false,
  },
  {
    id: "vat-payment",
    tax: "vat",
    kind: "payment",
    frequency: "monthly",
    day: 25,
    monthsAfter: 1,
    appliesTo: { vatPayer: true },
    source: SEED,
    approved: false,
  },
  {
    id: "income-report",
    tax: "income",
    kind: "report",
    frequency: "monthly",
    day: 15,
    monthsAfter: 1,
    source: SEED,
    approved: false,
  },
  {
    id: "social-report",
    tax: "social",
    kind: "report",
    frequency: "monthly",
    day: 15,
    monthsAfter: 1,
    source: SEED,
    approved: false,
  },
  {
    id: "profit-report",
    tax: "profit",
    kind: "report",
    frequency: "quarterly",
    day: 20,
    monthsAfter: 1,
    appliesTo: { regime: "general" },
    source: SEED,
    approved: false,
  },
  {
    id: "turnover-report",
    tax: "turnover",
    kind: "report",
    frequency: "quarterly",
    day: 20,
    monthsAfter: 1,
    appliesTo: { regime: "turnover" },
    source: SEED,
    approved: false,
  },
];

export interface DueDate {
  date: string;
  tax: Deadline["tax"];
  kind: Deadline["kind"];
  /** The period the deadline is for (YYYY-MM or YYYY-Qn or YYYY). */
  period: string;
  approved: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The deadlines that fall between two dates for a company's profile, earliest first. */
export function upcomingDeadlines(
  profile: TaxProfile,
  from: string,
  to: string,
  table: Deadline[] = TAX_DEADLINES,
): DueDate[] {
  const out: DueDate[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  // Periods that end up to a year before `from` can still have their deadline inside the range.
  for (let k = -14; k <= 14; k++) {
    const first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + k, 1));
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth() + 1;
    for (const d of table) {
      if (d.appliesTo?.regime && d.appliesTo.regime !== profile.regime) continue;
      if (d.appliesTo?.vatPayer !== undefined && d.appliesTo.vatPayer !== profile.vatPayer) continue;
      // A period ends in this month when it is monthly, or the month closes a quarter or the year.
      const ends =
        d.frequency === "monthly" ||
        (d.frequency === "quarterly" && month % 3 === 0) ||
        (d.frequency === "annual" && month === 12);
      if (!ends) continue;
      const due = new Date(Date.UTC(year, month - 1 + d.monthsAfter, d.day));
      const date = due.toISOString().slice(0, 10);
      if (date < from || date > to) continue;
      const period =
        d.frequency === "monthly"
          ? `${year}-${pad(month)}`
          : d.frequency === "quarterly"
            ? `${year}-Q${month / 3}`
            : String(year);
      out.push({ date, tax: d.tax, kind: d.kind, period, approved: d.approved });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.tax.localeCompare(b.tax));
}

// --- VAT registers against Didox -----------------------------------------------------------------------------------

export interface RegisterDoc {
  number: string;
  /** YYYY-MM-DD. */
  date: string;
  inn: string;
  amount: number;
}

export interface RegisterComparison {
  matched: number;
  onlyIn1c: RegisterDoc[];
  onlyInDidox: RegisterDoc[];
  amountDiffers: {
    number: string;
    date: string;
    inn: string;
    in1c: number;
    inDidox: number;
    difference: number;
  }[];
}

const keyOf = (d: RegisterDoc) =>
  `${d.inn.trim()}|${d.number.replace(/\s+/g, "").replace(/^0+/, "").toLowerCase()}`;

/** The VAT register of 1C against Didox's: a document is the same when the counterparty's INN and the number agree. */
export function compareRegisters(
  onec: RegisterDoc[],
  didox: RegisterDoc[],
  tolerance = 1,
): RegisterComparison {
  const theirs = new Map(didox.map((d) => [keyOf(d), d]));
  const seen = new Set<string>();
  const out: RegisterComparison = { matched: 0, onlyIn1c: [], onlyInDidox: [], amountDiffers: [] };
  for (const d of onec) {
    const key = keyOf(d);
    const other = theirs.get(key);
    if (!other) {
      out.onlyIn1c.push(d);
      continue;
    }
    seen.add(key);
    if (Math.abs(d.amount - other.amount) > tolerance)
      out.amountDiffers.push({
        number: d.number,
        date: d.date,
        inn: d.inn,
        in1c: d.amount,
        inDidox: other.amount,
        difference: round2(d.amount - other.amount),
      });
    else out.matched++;
  }
  for (const d of didox) if (!seen.has(keyOf(d))) out.onlyInDidox.push(d);
  return out;
}
