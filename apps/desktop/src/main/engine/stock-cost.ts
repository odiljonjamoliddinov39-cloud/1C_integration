/**
 * Does the cost 1C booked for the issues of an item agree with the cost method of the company? The method (average or
 * FIFO) comes from the company's own setting and is never chosen here. The movements of the item are replayed through
 * the program's costing and the cost of what was issued is set against what 1C booked on the credit side.
 */
import { accountingCalc } from "../calc.js";

export type CostMethod = "average" | "fifo" | "lifo";

export interface Movement {
  /** YYYY-MM-DD. */
  date: string;
  qtyIn: number;
  qtyOut: number;
  /** Cost booked with the receipt (debit) and with the issue (credit). */
  sumIn: number;
  sumOut: number;
}

export interface CostCheck {
  item: string;
  method: CostMethod;
  /** What the method gives for the issues, and what 1C booked. */
  expected: number;
  booked: number;
  difference: number;
  status: "match" | "difference" | "no_issues" | "short";
  closing: { qty: number; value: number };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function checkCost(
  item: string,
  movements: Movement[],
  method: CostMethod,
  tolerance = 0.5,
): CostCheck {
  // Within a day the receipts come first, so an issue that day can use them.
  const sorted = [...movements].sort((a, b) => a.date.localeCompare(b.date));
  const steps: { type: "in" | "out"; qty: number; unitCost?: number }[] = [];
  for (const day of sorted) {
    if (day.qtyIn > 0) steps.push({ type: "in", qty: day.qtyIn, unitCost: day.sumIn / day.qtyIn });
    if (day.qtyOut > 0) steps.push({ type: "out", qty: day.qtyOut });
  }
  const booked = round2(sorted.reduce((a, d) => a + d.sumOut, 0));
  const r = accountingCalc({ op: "costing", method, movements: steps }) as {
    issues: { note?: string }[];
    costOfGoodsSold: number;
    closing: { qty: number; value: number };
  };
  const short = r.issues.some((i) => i.note);
  const expected = round2(r.costOfGoodsSold);
  const difference = round2(booked - expected);
  return {
    item,
    method,
    expected,
    booked,
    difference,
    status: steps.every((s) => s.type === "in")
      ? "no_issues"
      : short
        ? "short"
        : Math.abs(difference) <= tolerance
          ? "match"
          : "difference",
    closing: r.closing,
  };
}
