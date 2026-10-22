/**
 * What moved the result (result.explain): the revenue, the cost and the period expenses by the first analytic of the
 * account (the counterparty, the product, the expense item, whatever the account is kept by), against an earlier
 * period of the same length, so the accountant sees who and what made the figure what it is, and what changed.
 */

export interface ExplainRow {
  /** Account code (9010, 9110, 9420…). */
  account: string;
  /** The first analytic as 1C presents it. */
  who: string;
  debit: number;
  credit: number;
}

export type Group = "revenue" | "costOfSales" | "periodExpenses";

export interface Driver {
  who: string;
  amount: number;
  /** Against the earlier period; null when none was given. */
  before: number | null;
  change: number | null;
  /** Share of the group's total, percent. */
  share: number;
}

export interface Explanation {
  group: Group;
  total: number;
  totalBefore: number | null;
  drivers: Driver[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const groupOf = (account: string): Group | null =>
  account.startsWith("90")
    ? "revenue"
    : account.startsWith("91")
      ? "costOfSales"
      : account.startsWith("94")
        ? "periodExpenses"
        : null;

function totals(rows: ExplainRow[]) {
  const map = new Map<Group, Map<string, number>>();
  for (const r of rows) {
    const group = groupOf(r.account);
    if (!group || r.account.length <= 3) continue;
    // Revenue is credit − debit (returns reduce it); costs are debit − credit.
    const value = group === "revenue" ? r.credit - r.debit : r.debit - r.credit;
    const who = r.who.trim() || "—";
    const inner = map.get(group) ?? new Map<string, number>();
    inner.set(who, round2((inner.get(who) ?? 0) + value));
    map.set(group, inner);
  }
  return map;
}

export function explainResult(now: ExplainRow[], before?: ExplainRow[], top = 8): Explanation[] {
  const current = totals(now);
  const earlier = before ? totals(before) : null;
  const groups: Group[] = ["revenue", "costOfSales", "periodExpenses"];
  return groups.flatMap((group) => {
    const inner = current.get(group);
    if (!inner || inner.size === 0) return [];
    const total = round2([...inner.values()].reduce((a, b) => a + b, 0));
    const prior = earlier?.get(group);
    const totalBefore = earlier ? round2([...(prior?.values() ?? [])].reduce((a, b) => a + b, 0)) : null;
    const whos = new Set([...inner.keys(), ...(prior?.keys() ?? [])]);
    const drivers: Driver[] = [...whos].map((who) => {
      const amount = inner.get(who) ?? 0;
      const was = earlier ? (prior?.get(who) ?? 0) : null;
      return {
        who,
        amount,
        before: was,
        change: was === null ? null : round2(amount - was),
        share: total === 0 ? 0 : round2((amount / total) * 100),
      };
    });
    // The biggest by amount; with an earlier period, the biggest movers too (they are what changed the result).
    const byAmount = [...drivers].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, top);
    const movers = earlier
      ? [...drivers].sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0)).slice(0, 3)
      : [];
    const chosen = [...new Map([...byAmount, ...movers].map((d) => [d.who, d])).values()];
    return [{ group, total, totalBefore, drivers: chosen }];
  });
}

/**
 * The period before this one: the same number of whole months when this one is whole months (a quarter, a year),
 * else the same number of days.
 */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const DAY = 86_400_000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const lastOfMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  if (start.getUTCDate() === 1 && end.getUTCDate() === lastOfMonth) {
    const months =
      (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() + 1;
    const before = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - months, 1));
    return { from: iso(before), to: iso(new Date(start.getTime() - DAY)) };
  }
  const length = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  const last = new Date(start.getTime() - DAY);
  return { from: iso(new Date(last.getTime() - (length - 1) * DAY)), to: iso(last) };
}
