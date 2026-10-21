/**
 * Simulation: thousands of generated calculations checked by what must always hold, not by remembered answers: an
 * allocation adds up to the cent, a loan ends at zero, a schedule's charges are the cost less the residual, costing
 * keeps value, VAT and payroll go there and back, a ratio of the same figures is the same.
 */
import { AccountingCalcInput } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { accountingCalc, allocate } from "../calc.js";
import { cases, Rng, seed } from "./rng.js";

const cents = (n: number) => Math.round(n * 100);
const sum = (list: number[]) => cents(list.reduce((a, b) => a + b, 0));
const run = (input: unknown) => {
  const parsed = AccountingCalcInput.parse(input);
  return accountingCalc(parsed) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe("simulation: the calculators keep their invariants", () => {
  it("allocation adds up to the cent, no part off by more than a cent from its exact share", () => {
    const rng = new Rng(seed(10));
    for (let i = 0; i < cases(4000); i++) {
      const total = rng.money(0, 5_000_000_000, rng.chance(0.7));
      const weights = Array.from({ length: rng.int(1, 40) }, () =>
        rng.chance(0.1) ? 0 : rng.money(1, 100000, true),
      );
      const parts = allocate(total, weights);
      const w = weights.reduce((a, b) => a + b, 0);
      if (w === 0) {
        expect(parts.every((p) => p === 0)).toBe(true);
        continue;
      }
      expect(sum(parts)).toBe(cents(total));
      parts.forEach((p, k) => {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(Math.abs(p * 100 - (cents(total) * (weights[k] ?? 0)) / w)).toBeLessThanOrEqual(1.0001);
        if (weights[k] === 0) expect(p).toBe(0);
      });
    }
  });

  it("VAT goes there and back for any rate and amount", () => {
    const rng = new Rng(seed(11));
    for (let i = 0; i < cases(4000); i++) {
      const amount = rng.money(1, 900_000_000, true);
      const rate = rng.pick([0, 12, 15, 20, 7.5]);
      const out = run({ op: "vat", amount, rate, mode: "exclusive" });
      expect(Math.abs(cents(out.net) + cents(out.vat) - cents(out.gross))).toBe(0);
      const back = run({ op: "vat", amount: out.gross, rate, mode: "inclusive" });
      expect(cents(back.net) + cents(back.vat)).toBe(cents(back.gross));
      // Rounding VAT out of the gross may differ by a cent or two from the net it came from, never more.
      expect(Math.abs(cents(back.net) - cents(amount))).toBeLessThanOrEqual(1 + Math.ceil(rate / 100));
    }
  });

  it("every depreciation method writes off exactly cost less residual, never below it", () => {
    const rng = new Rng(seed(12));
    for (let i = 0; i < cases(2500); i++) {
      const cost = rng.money(1000, 2_000_000_000, true);
      const residual = rng.chance(0.5) ? 0 : rng.money(0, Math.floor(cost / 2), true);
      const periods = rng.int(1, 120);
      const method = rng.pick(["straight_line", "declining_balance", "sum_of_years", "units"] as const);
      const units = Array.from({ length: periods }, () => rng.int(1, 5000));
      const out = run({
        op: "depreciation",
        cost,
        residual,
        periods,
        method,
        ...(method === "units" ? { units } : {}),
      });
      const schedule = out.schedule as { charge: number; accumulated: number; carrying: number }[];
      expect(schedule.length).toBe(periods);
      expect(sum(schedule.map((r) => r.charge))).toBe(cents(cost) - cents(residual));
      expect(cents(out.total)).toBe(cents(cost) - cents(residual));
      for (const r of schedule) {
        expect(r.charge).toBeGreaterThanOrEqual(0);
        expect(r.carrying).toBeGreaterThanOrEqual(residual - 0.005);
      }
      expect(schedule.at(-1)?.carrying).toBeCloseTo(residual, 2);
    }
  });

  it("a loan ends at zero, its principal parts add to the principal, interest is on the running balance", () => {
    const rng = new Rng(seed(13));
    for (let i = 0; i < cases(2500); i++) {
      const principal = rng.money(1000, 5_000_000_000, true);
      const months = rng.int(1, 120);
      const annualRate = rng.pick([0, 5, 12, 24, 36, 18.5]);
      const type = rng.pick(["annuity", "differentiated"] as const);
      const out = run({ op: "loan", principal, annualRate, months, type });
      const rows = out.schedule as {
        payment: number;
        interest: number;
        principal: number;
        balance: number;
      }[];
      expect(rows.length).toBe(months);
      expect(rows.at(-1)?.balance).toBe(0);
      expect(sum(rows.map((r) => r.principal))).toBe(cents(principal));
      expect(cents(out.totalPaid)).toBe(cents(principal) + sum(rows.map((r) => r.interest)));
      let balance = principal;
      for (const r of rows) {
        expect(cents(r.interest)).toBe(cents(balance * (annualRate / 1200)));
        expect(cents(r.payment)).toBe(cents(r.principal) + cents(r.interest));
        balance = Math.round((balance - r.principal) * 100) / 100;
        expect(r.balance).toBeCloseTo(balance, 2);
      }
      if (annualRate === 0) expect(out.totalInterest).toBe(0);
    }
  });

  it("NPV at the IRR is zero", () => {
    const rng = new Rng(seed(14));
    let checked = 0;
    for (let i = 0; i < cases(2000); i++) {
      const flows = [
        -rng.money(1000, 100000, true),
        ...Array.from({ length: rng.int(1, 12) }, () => rng.money(100, 60000, true)),
      ];
      const out = run({ op: "npv_irr", rate: rng.int(0, 40), cashflows: flows });
      if (out.irrPercent === null) {
        // No IRR only when the flows never pay back (or are all one sign).
        expect(flows.slice(1).reduce((a, b) => a + b, 0) <= -flows[0]!).toBe(true);
        continue;
      }
      const r = out.irrPercent / 100;
      const npv = flows.reduce((n, cf, t) => n + cf / Math.pow(1 + r, t), 0);
      expect(Math.abs(npv)).toBeLessThan(Math.max(1, Math.abs(flows[0]!)) * 0.001);
      checked++;
    }
    expect(checked).toBeGreaterThan(cases(2000) * 0.5);
  });

  it("costing: cost of goods sold plus what stays is what came in, for FIFO, LIFO and the average", () => {
    const rng = new Rng(seed(15));
    for (let i = 0; i < cases(2500); i++) {
      const opening = rng.chance(0.5)
        ? { qty: rng.int(1, 100), unitCost: rng.money(1, 500, true) }
        : undefined;
      const movements: { type: "in" | "out"; qty: number; unitCost?: number }[] = [];
      let stock = opening?.qty ?? 0;
      let value = opening ? opening.qty * opening.unitCost : 0;
      for (let k = 0; k < rng.int(1, 30); k++) {
        if (stock <= 0 || rng.chance(0.5)) {
          const qty = rng.int(1, 100);
          const unitCost = rng.money(1, 500, true);
          movements.push({ type: "in", qty, unitCost });
          stock += qty;
          value += qty * unitCost;
        } else {
          const qty = rng.int(1, stock);
          movements.push({ type: "out", qty });
          stock -= qty;
        }
      }
      for (const method of ["fifo", "lifo", "average"] as const) {
        const out = run({ op: "costing", method, ...(opening ? { opening } : {}), movements });
        const issues = out.issues as { cost: number; note?: string }[];
        expect(issues.every((x) => !x.note)).toBe(true);
        // Each issue and the stock are rounded to cents: a cent per line at most.
        const lines = issues.length + 2;
        expect(
          Math.abs(cents(out.costOfGoodsSold) + cents(out.closing.value) - Math.round(value * 100)),
        ).toBeLessThanOrEqual(lines);
        const sold = movements.filter((m) => m.type === "out").reduce((n, m) => n + m.qty, 0);
        const bought =
          movements.filter((m) => m.type === "in").reduce((n, m) => n + m.qty, 0) + (opening?.qty ?? 0);
        expect(out.closing.qty).toBeCloseTo(bought - sold, 3);
      }
    }
  });

  it("payroll: gross to net and net back to gross", () => {
    const rng = new Rng(seed(16));
    for (let i = 0; i < cases(3000); i++) {
      const gross = rng.money(100_000, 200_000_000, true);
      const taxAfterInps = rng.chance(0.5);
      const incomeTaxRate = rng.pick([12, 0, 10, 15]);
      const out = run({ op: "payroll", gross, taxAfterInps, incomeTaxRate });
      expect(cents(out.gross) - cents(out.incomeTax) - cents(out.inpsEmployee)).toBe(cents(out.net));
      expect(cents(out.employerCost)).toBe(cents(out.gross) + cents(out.employerSocial));
      const back = run({ op: "payroll", net: out.net, taxAfterInps, incomeTaxRate });
      // The same net can come from grosses a few cents apart; the net itself must come out the same within a cent.
      expect(Math.abs(cents(back.net) - cents(out.net))).toBeLessThanOrEqual(1);
      expect(Math.abs(cents(back.gross) - cents(gross))).toBeLessThanOrEqual(3);
    }
  });

  it("landed cost: freight, insurance and fees are all shared out, nothing lost, nothing counted twice", () => {
    const rng = new Rng(seed(17));
    for (let i = 0; i < cases(2000); i++) {
      const items = Array.from({ length: rng.int(1, 12) }, (_, k) => ({
        name: `item ${k}`,
        value: rng.money(10, 100000, true),
        qty: rng.int(1, 500),
        weight: rng.int(1, 5000),
        dutyRate: rng.pick([0, 5, 10, 15]),
      }));
      const rate = rng.pick([12650.5, 12800, 1]);
      const customsFee = rng.money(0, 5_000_000, true);
      const otherCosts = rng.money(0, 5_000_000, true);
      const freight = rng.money(0, 20000, true);
      const vatRecoverable = rng.chance(0.5);
      const out = run({
        op: "landed_cost",
        rate,
        items,
        freight,
        insurance: 0,
        customsFee,
        otherCosts,
        vatRate: 12,
        vatRecoverable,
        allocateBy: rng.pick(["value", "weight"] as const),
      });
      const lines = out.lines as Record<string, number>[];
      expect(sum(lines.map((l) => l.customsFee ?? 0))).toBe(cents(customsFee));
      expect(sum(lines.map((l) => l.otherCosts ?? 0))).toBe(cents(otherCosts));
      expect(sum(lines.map((l) => l.cost ?? 0))).toBe(cents(out.totals.cost));
      expect(sum(lines.map((l) => l.duty ?? 0))).toBe(cents(out.totals.duty));
      // Freight is part of the customs value of the goods: the foreign values add up to invoice + freight.
      const foreign = lines.reduce((n, l) => n + (l.customsValueForeign ?? 0), 0);
      expect(Math.abs(foreign - (items.reduce((n, x) => n + x.value, 0) + freight))).toBeLessThan(
        0.01 * (items.length + 1),
      );
    }
  });

  it("penalty never passes its cap and grows with the days; break-even covers its costs; ratios are consistent", () => {
    const rng = new Rng(seed(18));
    for (let i = 0; i < cases(2000); i++) {
      const principal = rng.money(1000, 900_000_000, true);
      const days = rng.int(0, 2000);
      const capPercent = rng.chance(0.5) ? rng.int(1, 100) : undefined;
      const a = run({ op: "penalty", principal, days, ...(capPercent ? { capPercent } : {}) });
      const b = run({ op: "penalty", principal, days: days + 1, ...(capPercent ? { capPercent } : {}) });
      if (capPercent) expect(a.penalty).toBeLessThanOrEqual(cents(principal * capPercent) / 10000 + 0.005);
      expect(b.penalty).toBeGreaterThanOrEqual(a.penalty);

      const price = rng.money(10, 5000, true);
      const variableCost = rng.money(1, 6000, true);
      const fixedCosts = rng.money(0, 1_000_000, true);
      const be = run({ op: "break_even", price, variableCost, fixedCosts });
      if (price > variableCost) {
        expect(be.breakEvenUnits * (price - variableCost)).toBeGreaterThanOrEqual(fixedCosts - 0.005);
        expect((be.breakEvenUnits - 1) * (price - variableCost)).toBeLessThan(fixedCosts + 1e-6);
      } else expect(be.error).toBeTruthy();

      const revenue = rng.money(1000, 1e9, true);
      const cogs = rng.money(0, revenue, true);
      const r = run({ op: "ratios", revenue, cogs, receivables: rng.money(0, revenue, true), days: 365 });
      expect(r.ratios.grossMarginPercent).toBeCloseTo(((revenue - cogs) / revenue) * 100, 1);
    }
  });

  it("FX revaluation: gains and losses net to the total; an unchanged rate is no difference", () => {
    const rng = new Rng(seed(19));
    for (let i = 0; i < cases(2000); i++) {
      const items = Array.from({ length: rng.int(1, 15) }, (_, k) => {
        const bookRate = rng.money(8000, 14000, true);
        return {
          name: `x${k}`,
          kind: rng.pick(["asset", "liability"] as const),
          amount: rng.money(1, 1_000_000, true),
          bookRate,
          closingRate: rng.chance(0.2) ? bookRate : rng.money(8000, 14000, true),
        };
      });
      const out = run({ op: "fx_revaluation", items });
      const lines = out.lines as { difference: number; kind: string }[];
      expect(sum(lines.map((l) => l.difference))).toBe(cents(out.total));
      lines.forEach((l, k) => {
        const it = items[k]!;
        if (it.bookRate === it.closingRate) expect(l.difference).toBe(0);
        const sign = Math.sign(it.closingRate - it.bookRate) * (it.kind === "asset" ? 1 : -1);
        expect(Math.sign(l.difference)).toBe(sign === 0 ? 0 : l.difference === 0 ? 0 : sign);
      });
    }
  });
});
