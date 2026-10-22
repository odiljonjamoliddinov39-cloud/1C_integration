/**
 * Tax rates and benefits live in tables with the date they apply from and to, never in the code that uses them: a
 * change of the law is a change of a row. A row says where it comes from and whether the tax adviser has approved it.
 * What the table does not hold comes back as "missing" (the adviser fills it), never as a guess.
 *
 * The rows below are the seed: the rates of the Tax Code of Uzbekistan as they were taken for this program. Every one
 * of them starts as `approved: false`; the adviser confirms them (see docs/accounting-engine.md) before they are
 * relied upon for a filing, and the answers say so while they are not.
 */

export type TaxType = "vat" | "profit" | "income" | "social" | "inps" | "turnover";

export interface TaxRate {
  type: TaxType;
  /** The kind of activity the rate is for; absent: every activity. */
  activity?: string;
  /** Percent. */
  rate: number;
  from: string;
  to?: string;
  source: string;
  approved: boolean;
}

export interface TaxBenefit {
  code: string;
  type: TaxType;
  /** What must hold for the benefit (read by the adviser and by `benefitApplies`). */
  conditions: Record<string, string | number | boolean>;
  effect: { kind: "reduce_rate" | "zero" | "exempt"; rate?: number };
  from: string;
  to?: string;
  source: string;
  approved: boolean;
}

const CODE = "Tax Code of the Republic of Uzbekistan (2020)";

export const TAX_RATES: TaxRate[] = [
  {
    type: "vat",
    rate: 20,
    from: "1900-01-01",
    to: "2018-12-31",
    source: "Tax Code before 2020",
    approved: false,
  },
  {
    type: "vat",
    rate: 15,
    from: "2019-01-01",
    to: "2022-12-31",
    source: `${CODE}, VAT rate`,
    approved: false,
  },
  {
    type: "vat",
    rate: 12,
    from: "2023-01-01",
    source: `${CODE}, VAT rate (12% from 1 Jan 2023)`,
    approved: false,
  },
  { type: "profit", rate: 15, from: "2020-01-01", source: `${CODE}, profit tax rate`, approved: false },
  {
    type: "profit",
    activity: "bank",
    rate: 20,
    from: "2020-01-01",
    source: `${CODE}, profit tax of banks`,
    approved: false,
  },
  { type: "income", rate: 12, from: "2019-01-01", source: `${CODE}, personal income tax`, approved: false },
  {
    type: "social",
    rate: 12,
    from: "2019-01-01",
    source: `${CODE}, social tax paid by the employer`,
    approved: false,
  },
  {
    type: "inps",
    rate: 0.1,
    from: "2019-01-01",
    source: "Pension fund contribution of the employee",
    approved: false,
  },
];

/** Benefits are filled by the tax adviser, from the source document of each; none is assumed here. */
export const TAX_BENEFITS: TaxBenefit[] = [];

const within = (date: string, from: string, to?: string) => date >= from && (!to || date <= to);

export interface RateAnswer {
  rate: number;
  source: string;
  approved: boolean;
}

/** The rate of a tax on a date for an activity (an activity row beats the general one); null: the table has none. */
export function rateOn(
  type: TaxType,
  date: string,
  activity?: string,
  rates: TaxRate[] = TAX_RATES,
): RateAnswer | null {
  const day = date.slice(0, 10);
  const rows = rates.filter((r) => r.type === type && within(day, r.from, r.to));
  const row =
    (activity ? rows.find((r) => r.activity === activity) : undefined) ?? rows.find((r) => !r.activity);
  return row ? { rate: row.rate, source: row.source, approved: row.approved } : null;
}

export type EntityType = "llc" | "private" | "family" | "sole_proprietor" | "other";

/** The company's tax profile: filled once, changed with a date. */
export interface TaxProfile {
  entity: EntityType;
  regime: "general" | "turnover";
  vatPayer: boolean;
  /** The date the company became a VAT payer. */
  vatFrom?: string;
  activities: string[];
  benefits: { code: string; basis: string; until?: string }[];
  validFrom: string;
}

export const DEFAULT_PROFILE: TaxProfile = {
  entity: "llc",
  regime: "general",
  vatPayer: true,
  activities: [],
  benefits: [],
  validFrom: "1900-01-01",
};

export interface VatAnswer {
  mode: "exclusive" | "inclusive";
  rate: number;
  net: number;
  vat: number;
  gross: number;
  /** A reason there is no VAT, or a warning, in words. */
  note?: string;
  source?: string;
  approved: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * VAT on an amount for a company on a date. A company that is not a VAT payer, or a zero-rated or exempt supply, has
 * none; otherwise the rate comes from the table for that date. Never takes a rate from anywhere else.
 */
export function vatOn(
  amount: number,
  mode: "exclusive" | "inclusive",
  date: string,
  profile: TaxProfile,
  options: { exempt?: boolean; zeroRated?: boolean; rates?: TaxRate[] } = {},
): VatAnswer | { error: string } {
  const none = (note: string): VatAnswer => ({
    mode,
    rate: 0,
    net: round2(amount),
    vat: 0,
    gross: round2(amount),
    note,
    approved: true,
  });
  if (!profile.vatPayer || (profile.vatFrom && date.slice(0, 10) < profile.vatFrom))
    return none("the company is not a VAT payer on this date");
  if (options.exempt) return none("the supply is exempt from VAT");
  if (options.zeroRated) return none("zero-rated supply: VAT 0%");
  const found = rateOn("vat", date, undefined, options.rates);
  if (!found)
    return { error: `The VAT rate for ${date} is not in the tax table: the tax adviser must add it.` };
  const factor = found.rate / 100;
  const net = mode === "exclusive" ? amount : amount / (1 + factor);
  const vat = mode === "exclusive" ? amount * factor : amount - net;
  return {
    mode,
    rate: found.rate,
    net: round2(net),
    vat: round2(vat),
    gross: round2(net + vat),
    source: found.source,
    approved: found.approved,
  };
}

/** Whether a benefit's conditions hold for the facts given (every condition named must equal the fact). */
export function benefitApplies(
  benefit: TaxBenefit,
  facts: Record<string, string | number | boolean>,
  date: string,
): boolean {
  if (!within(date.slice(0, 10), benefit.from, benefit.to)) return false;
  return Object.entries(benefit.conditions).every(([key, want]) => facts[key] === want);
}

/** The rate after the benefits of the profile that apply (the lowest wins; `exempt` and `zero` give 0). */
export function rateWithBenefits(
  type: TaxType,
  date: string,
  profile: TaxProfile,
  facts: Record<string, string | number | boolean> = {},
  tables: { rates?: TaxRate[]; benefits?: TaxBenefit[] } = {},
): (RateAnswer & { benefit?: string }) | null {
  const base = rateOn(type, date, profile.activities[0], tables.rates);
  if (!base) return null;
  let best: RateAnswer & { benefit?: string } = base;
  for (const held of profile.benefits) {
    if (held.until && date.slice(0, 10) > held.until) continue;
    const benefit = (tables.benefits ?? TAX_BENEFITS).find((b) => b.code === held.code && b.type === type);
    if (!benefit || !benefitApplies(benefit, facts, date)) continue;
    const rate = benefit.effect.kind === "reduce_rate" ? (benefit.effect.rate ?? base.rate) : 0;
    if (rate < best.rate)
      best = { rate, source: benefit.source, approved: benefit.approved, benefit: benefit.code };
  }
  return best;
}

/** Rows of the tables that nobody has approved yet: what the adviser still has to confirm. */
export function unapproved(rates: TaxRate[] = TAX_RATES, benefits: TaxBenefit[] = TAX_BENEFITS) {
  return [
    ...rates
      .filter((r) => !r.approved)
      .map((r) => `${r.type} ${r.rate}% ${r.activity ?? ""} from ${r.from}`.replace(/\s+/g, " ")),
    ...benefits.filter((b) => !b.approved).map((b) => `benefit ${b.code} (${b.type})`),
  ];
}
