/**
 * Payments to the budget, entered the way the company already enters them: the tax is named by the payment
 * (its purpose, its receiver), the newest posted «Уплата налога» document of the same tax is the template (so the
 * operation, the accounts, the tax office and the breakdown are the company's own), and only what changes with
 * the payment is set: its date, amount, number, purpose and the tax period. The period is the one the purpose
 * names; when it names none, it follows the company's habit read from its earlier payments of that tax (usually the
 * month before the payment).
 */

export type TaxKind =
  "ndfl" | "social" | "inps" | "vat" | "profit" | "property" | "land" | "water" | "turnover" | "excise";

/** How each tax is written in a payment purpose, and in the name of the tax in 1C. */
const KINDS: { kind: TaxKind; purpose: RegExp; name: RegExp }[] = [
  {
    kind: "ndfl",
    purpose:
      /(?<!\p{L})(ндфл|жшдс|jshds|подоходн\p{L}*|доход\p{L}*\s+физическ\p{L}*|daromad\s+solig\p{L}*|даромад\s+солиғ\p{L}*)(?!\p{L})/iu,
    name: /ндфл|подоход|физическ|жшдс/iu,
  },
  {
    kind: "social",
    purpose: /(?<!\p{L})(социальн\p{L}*|ижтимоий|ijtimoiy|единый\s+социальный|есп|esp)(?!\p{L})/iu,
    name: /социал|ижтимо|единый/iu,
  },
  {
    kind: "inps",
    purpose: /(?<!\p{L})(инпс|inps|накопительн\p{L}*)(?!\p{L})/iu,
    name: /инпс|накоп/iu,
  },
  {
    kind: "vat",
    purpose: /(?<!\p{L})(ндс|qqs|налог\p{L}*\s+на\s+добавленн\p{L}*)(?!\p{L})/iu,
    name: /ндс|добавлен/iu,
  },
  {
    kind: "profit",
    purpose: /(?<!\p{L})(прибыл\p{L}*|foyda\p{L}*|фойда\p{L}*)(?!\p{L})/iu,
    name: /прибыл|фойда/iu,
  },
  {
    kind: "property",
    purpose: /(?<!\p{L})(имуществ\p{L}*|mol-?mulk\p{L}*|мол-?мулк\p{L}*)(?!\p{L})/iu,
    name: /имуществ|мулк/iu,
  },
  {
    kind: "land",
    purpose: /(?<!\p{L})(земел\p{L}*|yer\s+solig\p{L}*)(?!\p{L})/iu,
    name: /земел/iu,
  },
  {
    kind: "water",
    purpose: /(?<!\p{L})(водн\p{L}*|suv\s+resurs\p{L}*|за\s+воду)(?!\p{L})/iu,
    name: /водн|вод/iu,
  },
  {
    kind: "turnover",
    purpose: /(?<!\p{L})(оборот\p{L}*|aylanma\p{L}*)(?!\p{L})/iu,
    name: /оборот/iu,
  },
  {
    kind: "excise",
    purpose: /(?<!\p{L})(акциз\p{L}*|aksiz\p{L}*)(?!\p{L})/iu,
    name: /акциз/iu,
  },
];

/** Which tax a payment is for, by its purpose; null when it names none (the model decides). */
export function taxKindOf(purpose: string): TaxKind | null {
  // Order matters: "налог на доходы физических лиц" is ндфл before the general word "налог".
  const found = KINDS.filter((k) => k.purpose.test(purpose));
  // A purpose that names two ("НДФЛ и социальный налог") is not one tax: it is left to the model.
  return found.length === 1 ? (found[0]?.kind ?? null) : null;
}

/** Does the name of a tax in 1C ("Налог на доходы физических лиц", "Единый социальный платёж") stand for this kind? */
export const taxNameIs = (kind: TaxKind, name: string): boolean =>
  KINDS.find((k) => k.kind === kind)?.name.test(name) ?? false;

const MONTHS: [RegExp, number][] = [
  [/январ|yanvar|январь/iu, 1],
  [/феврал|fevral/iu, 2],
  [/март|mart/iu, 3],
  [/апрел|aprel/iu, 4],
  [/(?<!\p{L})ма[йяе]|(?<!\p{L})may/iu, 5],
  [/июн|iyun/iu, 6],
  [/июл|iyul/iu, 7],
  [/август|avgust/iu, 8],
  [/сентябр|sentyabr/iu, 9],
  [/октябр|oktyabr/iu, 10],
  [/ноябр|noyabr/iu, 11],
  [/декабр|dekabr/iu, 12],
];

/** The month ("2026-09") a purpose names: "за сентябрь 2026", "за 09.2026", "август 2026 г."; "" when it names none. */
export function periodOfPurpose(purpose: string, paidOn: string): string {
  // "09.2026" or "9/2026"; a full date ("12.10.2026") is not a period: its month has a day and a dot before it.
  const numeric = /(?<![\d.])(0?[1-9]|1[0-2])[./](20\d{2})(?!\d)/.exec(purpose);
  if (numeric) return `${numeric[2]}-${String(numeric[1]).padStart(2, "0")}`;
  for (const [word, month] of MONTHS) {
    const at = word.exec(purpose);
    if (!at) continue;
    // A month word counts only as "за сентябрь" or "сентябрь 2026": "договор от 15 марта" is not a period.
    const year = /^\p{L}*\s*(?:г\.?\s*)?(20\d{2})/u.exec(purpose.slice(at.index + at[0].length))?.[1];
    const afterZa = /(?:за|для)\s+$/iu.test(purpose.slice(0, at.index));
    if (year) return `${year}-${String(month).padStart(2, "0")}`;
    if (afterZa) {
      const [y, m] = [Number(paidOn.slice(0, 4)), Number(paidOn.slice(5, 7))];
      return `${month > m ? y - 1 : y}-${String(month).padStart(2, "0")}`;
    }
  }
  return "";
}

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/** The months between a payment and the period it was for ("1" = the month before). */
export function lagOf(paidOn: string, period: string): number {
  return monthIndex(paidOn) - monthIndex(period);
}

/** The most common lag in the company's earlier payments of this tax, or null when there are none to learn from. */
export function usualLag(history: { date: string; period: string }[]): number | null {
  const counts = new Map<number, number>();
  for (const h of history) {
    if (!h.period || !h.date) continue;
    const lag = lagOf(h.date, h.period);
    // A period after the payment, or years before it, is not a habit but a correction or an arrear.
    if (lag < 0 || lag > 12) continue;
    counts.set(lag, (counts.get(lag) ?? 0) + 1);
  }
  let best: number | null = null;
  let most = 0;
  for (const [lag, n] of counts) {
    if (n > most || (n === most && best !== null && lag < best)) {
      best = lag;
      most = n;
    }
  }
  return best;
}

/** The first day of the month `lag` months before a payment, "YYYY-MM-01T00:00:00". */
export function periodBefore(paidOn: string, lag: number): string {
  const index = monthIndex(paidOn) - lag;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-01T00:00:00`;
}

export interface TaxPeriod {
  /** "YYYY-MM-01T00:00:00". */
  value: string;
  /** Where it came from, for the accountant. */
  source: "purpose" | "habit" | "template";
  /** For "habit": the lag in months. */
  lag?: number;
}

/** The tax period for a payment: what its purpose says, else the company's habit; null when neither is known. */
export function taxPeriodFor(
  purpose: string,
  paidOn: string,
  history: { date: string; period: string }[],
): TaxPeriod | null {
  const named = periodOfPurpose(purpose, paidOn);
  if (named) return { value: `${named}-01T00:00:00`, source: "purpose" };
  const lag = usualLag(history);
  if (lag === null) return null;
  return { value: periodBefore(paidOn, lag), source: "habit", lag };
}
