/**
 * How old the debts are (aging). The settlement account's entries are read for a window; a debit (receivables) or a
 * credit (payables) opens an item on its date, the other side settles the oldest items first (FIFO), and what is left
 * is aged from the item's date: 0–30, 31–60, 61–90, over 90 days. Money received before anything was due is an advance,
 * kept apart. The balance at the start of the window is one item as old as the window, so it falls in the oldest bucket.
 */

export interface DebtEntry {
  party: string;
  /** YYYY-MM-DD. */
  date: string;
  debit: number;
  credit: number;
}

export const BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;

export interface AgingParty {
  party: string;
  total: number;
  /** Amounts by bucket, in the order of BUCKETS. */
  buckets: [number, number, number, number];
  /** Days since the oldest item still open. */
  oldestDays: number;
}

export interface AgingReport {
  kind: "receivables" | "payables";
  date: string;
  total: number;
  buckets: [number, number, number, number];
  /** What is past 30 days. */
  overdue: number;
  parties: AgingParty[];
  advances: { party: string; amount: number }[];
  advancesTotal: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
const days = (from: string, to: string) => Math.floor((Date.parse(to) - Date.parse(from)) / DAY);
const bucketOf = (age: number) => (age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3);

export function ageDebts(
  kind: AgingReport["kind"],
  entries: DebtEntry[],
  date: string,
  top = 30,
): AgingReport {
  const byParty = new Map<string, DebtEntry[]>();
  for (const e of entries) {
    if (e.date > date) continue;
    const party = e.party.trim() || "—";
    byParty.set(party, [...(byParty.get(party) ?? []), { ...e, party }]);
  }
  const parties: AgingParty[] = [];
  const advances: { party: string; amount: number }[] = [];
  for (const [party, list] of byParty) {
    // On one day the new items come before the settlements, so a same-day payment settles a same-day invoice.
    list.sort((a, b) => a.date.localeCompare(b.date));
    const open: { date: string; amount: number }[] = [];
    let advance = 0;
    for (const e of list) {
      // Receivables: the debit opens an item and the credit settles; payables: the other way round.
      const opens = round2(kind === "receivables" ? e.debit : e.credit);
      const settles = round2(kind === "receivables" ? e.credit : e.debit);
      if (opens > 0) {
        // A new item first takes what was paid in advance.
        const used = Math.min(advance, opens);
        advance = round2(advance - used);
        if (opens - used > 0.004) open.push({ date: e.date, amount: round2(opens - used) });
      }
      let rest = settles;
      while (rest > 0.004) {
        const first = open[0];
        if (!first) break;
        const take = Math.min(first.amount, rest);
        first.amount = round2(first.amount - take);
        rest = round2(rest - take);
        if (first.amount <= 0.004) open.shift();
      }
      if (rest > 0.004) advance = round2(advance + rest);
    }
    const buckets: [number, number, number, number] = [0, 0, 0, 0];
    for (const item of open) buckets[bucketOf(days(item.date, date))] += item.amount;
    const total = round2(buckets.reduce((a, b) => a + b, 0));
    if (total > 0.004)
      parties.push({
        party,
        total,
        buckets: buckets.map(round2) as AgingParty["buckets"],
        oldestDays: open[0] ? days(open[0].date, date) : 0,
      });
    if (advance > 0.004) advances.push({ party, amount: advance });
  }
  parties.sort((a, b) => b.total - a.total);
  advances.sort((a, b) => b.amount - a.amount);
  const buckets: [number, number, number, number] = [0, 0, 0, 0];
  for (const p of parties)
    for (let i = 0; i < 4; i++) buckets[i] = round2((buckets[i] ?? 0) + (p.buckets[i] ?? 0));
  const total = round2(buckets.reduce((a, b) => a + b, 0));
  return {
    kind,
    date,
    total,
    buckets,
    overdue: round2(buckets[1] + buckets[2] + buckets[3]),
    parties: parties.slice(0, top),
    advances: advances.slice(0, top),
    advancesTotal: round2(advances.reduce((a, b) => a + b.amount, 0)),
  };
}
