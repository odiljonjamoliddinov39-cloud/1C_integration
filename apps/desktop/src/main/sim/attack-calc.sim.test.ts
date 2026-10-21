/**
 * Attack: the calculators fed with whatever the schema lets through (extremes, zeros, empty lists, tiny and huge
 * numbers, odd combinations). A tool must never answer NaN or Infinity, never throw, and always give a result that
 * can be sent as JSON; what cannot be computed must say so.
 */
import { AccountingCalcInput } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { accountingCalc } from "../calc.js";
import { cases, Rng, seed } from "./rng.js";

const EXTREME = [0, 0, 0.01, 1, 2, 12, 100, 1e6, 1e9, 1e12, 1e15, -1, -1e6, 0.0049, 0.005, 99999.995];

const num = (rng: Rng, lo = -1e15, hi = 1e15): number => {
  const v = rng.chance(0.6) ? rng.pick(EXTREME) : rng.money(0, 1e8, true) * (rng.chance(0.2) ? -1 : 1);
  return Math.min(hi, Math.max(lo, v));
};
const pos = (rng: Rng) => Math.max(0.0001, Math.abs(num(rng)));
const pct = (rng: Rng) => Math.min(1000, Math.abs(num(rng, 0, 1000)));
const list = <T>(rng: Rng, make: () => T, max = 12): T[] => Array.from({ length: rng.int(1, max) }, make);

function anyInput(rng: Rng): unknown {
  switch (rng.int(0, 11)) {
    case 0:
      return { op: "vat", amount: num(rng), rate: pct(rng), mode: rng.pick(["exclusive", "inclusive"]) };
    case 1:
      return {
        op: "depreciation",
        cost: num(rng),
        residual: rng.chance(0.5) ? num(rng) : undefined,
        periods: rng.int(1, 600),
        method: rng.pick(["straight_line", "declining_balance", "sum_of_years", "units"]),
        factor: rng.chance(0.3) ? rng.pick([1, 2, 5]) : undefined,
        units: rng.chance(0.7) ? list(rng, () => rng.pick([0, 1, 5, 1000]), 30) : undefined,
      };
    case 2:
      return {
        op: "loan",
        principal: num(rng),
        annualRate: pct(rng),
        months: rng.int(1, 600),
        type: rng.pick(["annuity", "differentiated"]),
      };
    case 3:
      return {
        op: "npv_irr",
        rate: pct(rng),
        cashflows: list(rng, () => num(rng), 20).concat(rng.chance(0.5) ? [num(rng)] : [0]),
      };
    case 4:
      return {
        op: "fx_revaluation",
        items: list(rng, () => ({
          name: "x",
          kind: rng.pick(["asset", "liability"]),
          amount: num(rng),
          bookRate: pos(rng),
          closingRate: pos(rng),
        })),
      };
    case 5:
      return {
        op: "costing",
        method: rng.pick(["fifo", "lifo", "average"]),
        opening: rng.chance(0.5) ? { qty: Math.abs(num(rng)), unitCost: Math.abs(num(rng)) } : undefined,
        movements: list(
          rng,
          () => ({
            type: rng.pick(["in", "out"]),
            qty: pos(rng),
            unitCost: rng.chance(0.8) ? Math.abs(num(rng)) : undefined,
          }),
          30,
        ),
      };
    case 6:
      return {
        op: "payroll",
        gross: rng.chance(0.6) ? num(rng) : undefined,
        net: rng.chance(0.4) ? num(rng) : undefined,
        incomeTaxRate: rng.chance(0.5) ? pct(rng) : undefined,
        inpsRate: rng.chance(0.5) ? pct(rng) : undefined,
        taxAfterInps: rng.chance(0.5),
      };
    case 7:
      return {
        op: "landed_cost",
        rate: pos(rng),
        items: list(
          rng,
          () => ({
            name: "i",
            value: Math.abs(num(rng)),
            qty: rng.chance(0.7) ? pos(rng) : undefined,
            weight: Math.abs(num(rng)),
            dutyRate: pct(rng),
            exciseRate: pct(rng),
          }),
          8,
        ),
        freight: Math.abs(num(rng)),
        allocateBy: rng.pick(["value", "weight"]),
        customsFee: Math.abs(num(rng)),
        vatRate: pct(rng),
      };
    case 8:
      return {
        op: "penalty",
        principal: num(rng),
        days: rng.chance(0.5) ? rng.int(0, 36500) : undefined,
        from: rng.chance(0.4) ? rng.date(2020, 2026) : undefined,
        to: rng.chance(0.4) ? rng.date(2020, 2026) : undefined,
        ratePerDay: rng.chance(0.5) ? rng.pick([0, 0.033, 10]) : undefined,
        capPercent: rng.chance(0.5) ? rng.pick([0, 50, 1000]) : undefined,
      };
    case 9:
      return {
        op: "ratios",
        currentAssets: num(rng),
        currentLiabilities: num(rng),
        inventory: num(rng),
        revenue: num(rng),
        cogs: num(rng),
        netIncome: num(rng),
        equity: num(rng),
        receivables: num(rng),
        days: rng.int(1, 366),
      };
    case 10:
      return {
        op: "break_even",
        price: num(rng),
        variableCost: num(rng),
        fixedCosts: num(rng),
        targetProfit: rng.chance(0.5) ? num(rng) : undefined,
      };
    default:
      return {
        op: "allocate",
        total: num(rng),
        weights: list(rng, () => rng.pick([0, 0, 1, 3, 1e6, 0.001, -1]), 30),
      };
  }
}

/** Every number in a result is a finite one. */
function bad(value: unknown, path = ""): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : `${path} = ${value}`;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const b = bad(v, `${path}[${i}]`);
      if (b) return b;
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const b = bad(v, `${path}.${k}`);
      if (b) return b;
    }
  }
  return null;
}

describe("attack: the calculators", () => {
  it("never answer NaN or Infinity, never throw, whatever the schema lets through", () => {
    const rng = new Rng(seed(200));
    const problems: string[] = [];
    let accepted = 0;
    const n = cases(8000);
    for (let i = 0; i < n; i++) {
      const input = JSON.parse(JSON.stringify(anyInput(rng)));
      const parsed = AccountingCalcInput.safeParse(input);
      if (!parsed.success) continue;
      accepted++;
      try {
        const out = accountingCalc(parsed.data);
        const found = bad(out);
        if (found) problems.push(`${JSON.stringify(input).slice(0, 160)} → ${found}`);
        JSON.stringify(out);
      } catch (e) {
        problems.push(`${JSON.stringify(input).slice(0, 160)} threw ${String(e)}`);
      }
    }
    expect(accepted).toBeGreaterThan(n / 3);
    const ops = new Set(problems.map((p) => /"op":"(\w+)"/.exec(p)?.[1]));
    expect(problems.slice(0, 12), `${problems.length} problems in ${[...ops].join(", ")}`).toEqual([]);
  });
});
