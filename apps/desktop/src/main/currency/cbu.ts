/**
 * The Central Bank of Uzbekistan's official exchange rates (cbu.uz): soums per unit of a currency, one answer per day.
 * 1C keeps them in a register that nothing but PlatformAPI can write to; this is where the figures come from.
 */

export interface DayRate {
  /** YYYY-MM-DD */
  date: string;
  /** Soums per `multiplicity` units. */
  rate: number;
  multiplicity: number;
}

const BASE = "https://cbu.uz/ru/arkhiv-kursov-valyut/json";

/** Days read at once from the bank (it is a public site: a few at a time). */
const PARALLEL = 6;
/** Most days one call reads: a year and a half. */
export const MAX_DAYS = 550;

/** Every day from `from` to `to`, both included (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** One answer of the bank for a day, or null when it has no rate for that currency and day. */
export function parseCbu(body: unknown, currency: string, date: string): DayRate | null {
  if (!Array.isArray(body)) return null;
  const found = body.find(
    (row) =>
      row && typeof row === "object" && String((row as { Ccy?: unknown }).Ccy).toUpperCase() === currency,
  ) as { Rate?: unknown; Nominal?: unknown } | undefined;
  if (!found) return null;
  const rate = Number(String(found.Rate).replace(",", "."));
  const multiplicity = Number(found.Nominal ?? 1) || 1;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return { date, rate, multiplicity };
}

export interface CbuResult {
  rates: DayRate[];
  /** Days the bank could not be asked (network), not days it has no rate for. */
  failed: number;
}

export async function fetchCbuRates(
  currency: string,
  from: string,
  to: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<CbuResult> {
  const days = daysBetween(from, to);
  if (days.length > MAX_DAYS)
    throw new Error(`At most ${MAX_DAYS} days of rates at once; ask for a shorter period`);
  const get = options.fetch ?? fetch;
  const rates: DayRate[] = [];
  let failed = 0;
  let next = 0;
  const one = async (date: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (options.signal?.aborted) return;
      try {
        const signal = options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000);
        const res = await get(`${BASE}/${currency}/${date}/`, { signal });
        if (!res.ok) continue;
        const rate = parseCbu(await res.json(), currency, date);
        if (rate) rates.push(rate);
        return;
      } catch {
        // asked again once
      }
    }
    failed += 1;
  };
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, days.length) }, async () => {
      while (next < days.length) await one(days[next++] as string);
    }),
  );
  return { rates: rates.sort((a, b) => a.date.localeCompare(b.date)), failed };
}

/** What to write: the days the bank has a rate for and 1C has none; counted: those 1C has the same, and those it has otherwise. */
export function planRates(
  bank: DayRate[],
  existing: Map<string, number>,
): { toWrite: DayRate[]; same: number; differ: number } {
  const toWrite: DayRate[] = [];
  let same = 0;
  let differ = 0;
  let last: number | null = null;
  for (const day of bank) {
    const have = existing.get(day.date);
    const perUnit = day.rate / day.multiplicity;
    if (have !== undefined) {
      if (Math.abs(have - perUnit) < 0.0001) same += 1;
      else differ += 1;
      last = perUnit;
      continue;
    }
    // 1C carries a rate forward until the next one: a day with the rate of the day before needs no record of its own.
    if (last !== null && Math.abs(last - perUnit) < 0.0001) continue;
    toWrite.push(day);
    last = perUnit;
  }
  return { toWrite, same, differ };
}
