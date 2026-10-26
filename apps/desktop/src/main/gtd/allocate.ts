/**
 * The customs fee goes into the cost of the goods, so it is shared over the items in proportion to their value, to the
 * kopeck: each share is rounded to 0.01 and the rounding remainder goes to the item with the largest value, so the shares add
 * up to exactly the fee. A charge that stands on an item's own sheet belongs to that item alone.
 */
import { type Dec, ZERO, add, cmp, fixed, isZero, mulDiv, round, sub, sum } from "./decimal.js";

export interface Share {
  no: number;
  amount: Dec;
}

export interface Allocation {
  shares: Share[];
  /** What the rounding left over, and the item it went to. */
  remainder: Dec;
  remainderItem: number | null;
}

/** Shares `total` over the items by `value`. Null when the values cannot carry a share (none, or all zero). */
export function allocate(total: Dec, items: { no: number; value: Dec }[]): Allocation | null {
  const weight = sum(items.map((i) => i.value));
  if (items.length === 0 || isZero(weight) || items.some((i) => i.value.units < 0n)) return null;
  const shares = items.map((i) => ({ no: i.no, amount: mulDiv(total, i.value, weight, 2) ?? ZERO }));
  const remainder = sub(round(total, 2), sum(shares.map((s) => s.amount)));
  // The largest value takes the remainder; two of the same value: the lower number.
  const largest = items.reduce(
    (best, i) => (cmp(i.value, best.value) > 0 ? i : best),
    items[0] as (typeof items)[number],
  );
  const adjusted = shares.map((s) =>
    s.no === largest.no ? { no: s.no, amount: add(s.amount, remainder) } : s,
  );
  return { shares: adjusted, remainder, remainderItem: isZero(remainder) ? null : largest.no };
}

export interface ChargeLine {
  amount: Dec;
  /** null: declaration-level. */
  itemNo: number | null;
}

/** The charges of the declaration as an amount per item: item-level lines to their item, the rest shared by value. */
export function allocateCharges(
  lines: ChargeLine[],
  items: { no: number; value: Dec }[],
): { perItem: Share[]; total: Dec; allocation: Allocation | null } | null {
  const own = new Map<number, Dec>();
  let shared = ZERO;
  for (const line of lines) {
    if (line.itemNo === null) shared = add(shared, line.amount);
    else own.set(line.itemNo, add(own.get(line.itemNo) ?? ZERO, line.amount));
  }
  for (const no of own.keys()) if (!items.some((i) => i.no === no)) return null;
  const allocation = isZero(shared) ? null : allocate(shared, items);
  if (!isZero(shared) && !allocation) return null;
  const perItem = items.map((i) => ({
    no: i.no,
    amount: add(allocation?.shares.find((s) => s.no === i.no)?.amount ?? ZERO, own.get(i.no) ?? ZERO),
  }));
  return { perItem, total: sum(lines.map((l) => l.amount)), allocation };
}

export const money = (d: Dec) => fixed(d, 2);
