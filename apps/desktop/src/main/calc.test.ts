/* eslint-disable @typescript-eslint/no-explicit-any -- results are read by field in assertions */
import { describe, expect, it } from "vitest";

import { AccountingCalcInput } from "@platform/shared";

import { accountingCalc, allocate } from "./calc.js";

const run = (input: unknown) => accountingCalc(AccountingCalcInput.parse(input)) as Record<string, any>;

describe("allocate", () => {
  it("shares a total to the cent so that the parts add up exactly", () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts).toEqual([33.34, 33.33, 33.33]);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    expect(allocate(10, [3, 0, 7])).toEqual([3, 0, 7]);
    expect(allocate(5, [0, 0])).toEqual([0, 0]);
  });
});

describe("vat", () => {
  it("takes VAT out of a gross amount and puts it on a net one", () => {
    expect(run({ op: "vat", amount: 242_200_000, rate: 12, mode: "inclusive" })).toMatchObject({
      net: 216_250_000,
      vat: 25_950_000,
    });
    expect(run({ op: "vat", amount: 216_250_000, rate: 12, mode: "exclusive" })).toMatchObject({
      vat: 25_950_000,
      gross: 242_200_000,
    });
    expect(run({ op: "vat", amount: 1000, rate: 15, mode: "exclusive" })).toMatchObject({
      vat: 150,
      gross: 1150,
    });
  });
});

describe("depreciation", () => {
  it("straight line adds up to the depreciable amount, a cent left over going to the first periods", () => {
    const r = run({
      op: "depreciation",
      cost: 100_000,
      residual: 10_000,
      periods: 3,
      method: "straight_line",
    });
    expect(r.schedule.map((x: any) => x.charge)).toEqual([30_000, 30_000, 30_000]);
    expect(r.total).toBe(90_000);
    expect(r.schedule[2].carrying).toBe(10_000);
    const odd = run({ op: "depreciation", cost: 100, periods: 3, method: "straight_line" });
    expect(odd.total).toBe(100);
  });

  it("declining balance never goes under the residual and clears it in the last period", () => {
    const r = run({
      op: "depreciation",
      cost: 10_000,
      residual: 1_000,
      periods: 5,
      method: "declining_balance",
    });
    expect(r.schedule[0].charge).toBe(4_000);
    expect(r.schedule.at(-1).carrying).toBe(1_000);
    expect(r.total).toBe(9_000);
  });

  it("sum of the years' digits and units of output", () => {
    const syd = run({ op: "depreciation", cost: 15_000, periods: 5, method: "sum_of_years" });
    expect(syd.schedule.map((x: any) => x.charge)).toEqual([5_000, 4_000, 3_000, 2_000, 1_000]);
    const units = run({
      op: "depreciation",
      cost: 1_000,
      periods: 3,
      method: "units",
      units: [100, 300, 600],
    });
    expect(units.schedule.map((x: any) => x.charge)).toEqual([100, 300, 600]);
  });
});

describe("loan", () => {
  it("annuity: the usual instalment, the balance cleared to zero", () => {
    const r = run({ op: "loan", principal: 1_000_000, annualRate: 12, months: 12, type: "annuity" });
    expect(r.firstPayment).toBeCloseTo(88_848.79, 1);
    expect(r.schedule.at(-1).balance).toBe(0);
    expect(r.totalInterest).toBeCloseTo(66_185.5, 0);
    expect(r.totalPaid).toBeCloseTo(1_066_185.5, 0);
  });

  it("differentiated: equal principal, falling interest", () => {
    const r = run({ op: "loan", principal: 1_200, annualRate: 12, months: 12, type: "differentiated" });
    expect(r.schedule[0]).toMatchObject({ principal: 100, interest: 12, payment: 112 });
    expect(r.schedule[11]).toMatchObject({ principal: 100, interest: 1, payment: 101, balance: 0 });
  });
});

describe("npv_irr", () => {
  it("discounts the flows and finds the rate that makes the NPV zero", () => {
    const r = run({ op: "npv_irr", rate: 10, cashflows: [-1000, 500, 500, 500] });
    expect(r.npv).toBeCloseTo(243.43, 1);
    expect(r.irrPercent).toBeCloseTo(23.38, 1);
    expect(r.paybackPeriods).toBe(2);
  });

  it("has no internal rate when every flow has the same sign", () => {
    expect(run({ op: "npv_irr", rate: 10, cashflows: [100, 100] }).irrPercent).toBeNull();
  });
});

describe("fx_revaluation", () => {
  it("an asset worth more is a gain, a liability that costs more is a loss", () => {
    const r = run({
      op: "fx_revaluation",
      items: [
        { name: "Receivable", kind: "asset", amount: 1000, bookRate: 12_000, closingRate: 12_700 },
        { name: "Supplier", kind: "liability", amount: 500, bookRate: 12_000, closingRate: 12_700 },
      ],
    });
    expect(r.lines[0]).toMatchObject({ difference: 700_000, result: "exchange gain" });
    expect(r.lines[1]).toMatchObject({ difference: -350_000, result: "exchange loss" });
    expect(r.total).toBe(350_000);
  });
});

describe("costing", () => {
  const movements = [
    { type: "in", qty: 10, unitCost: 100 },
    { type: "in", qty: 10, unitCost: 120 },
    { type: "out", qty: 15 },
  ];
  const opening = { qty: 0, unitCost: 0 };

  it("FIFO takes the oldest lots first, LIFO the newest", () => {
    const fifo = run({ op: "costing", method: "fifo", opening, movements });
    expect(fifo.costOfGoodsSold).toBe(1_600);
    expect(fifo.closing).toMatchObject({ qty: 5, value: 600, unitCost: 120 });
    const lifo = run({ op: "costing", method: "lifo", opening, movements });
    expect(lifo.costOfGoodsSold).toBe(1_700);
  });

  it("the average costs every unit alike", () => {
    const avg = run({ op: "costing", method: "average", opening, movements });
    expect(avg.costOfGoodsSold).toBe(1_650);
    expect(avg.closing.value).toBe(550);
  });

  it("says when stock runs short", () => {
    const r = run({
      op: "costing",
      method: "fifo",
      movements: [
        { type: "in", qty: 5, unitCost: 10 },
        { type: "out", qty: 8 },
      ],
    });
    expect(r.issues[0].note).toContain("3 short");
  });
});

describe("payroll", () => {
  it("gross to net with the defaults, and says which rates it used", () => {
    const r = run({ op: "payroll", gross: 10_000_000 });
    expect(r).toMatchObject({
      incomeTax: 1_200_000,
      inpsEmployee: 10_000,
      net: 8_790_000,
      employerSocial: 1_200_000,
    });
    expect(r.ratesUsed).toEqual({ incomeTax: 12, inpsEmployee: 0.1, employerSocial: 12 });
    expect(r.employerCost).toBe(11_200_000);
  });

  it("net to gross gives the gross that nets to that figure", () => {
    const r = run({ op: "payroll", net: 8_790_000 });
    expect(r.gross).toBe(10_000_000);
    expect(run({ op: "payroll", gross: r.gross }).net).toBe(8_790_000);
  });

  it("takes the rates it is given, and the income tax on the gross less INPS when told", () => {
    const r = run({
      op: "payroll",
      gross: 1_000_000,
      incomeTaxRate: 10,
      inpsRate: 1,
      employerSocialRate: 25,
      taxAfterInps: true,
    });
    expect(r).toMatchObject({
      inpsEmployee: 10_000,
      incomeTax: 99_000,
      net: 891_000,
      employerSocial: 250_000,
    });
  });
});

describe("landed_cost", () => {
  it("builds the cost of an import by item: freight shared by value, duty, import VAT apart", () => {
    const r = run({
      op: "landed_cost",
      rate: 12_000,
      items: [
        { name: "A", value: 1_000, qty: 10, dutyRate: 10 },
        { name: "B", value: 3_000, qty: 30, dutyRate: 0 },
      ],
      freight: 400,
      customsFee: 1_000_000,
      vatRate: 12,
    });
    // Freight 400 is shared 100 / 300; A is (1000 + 100) × 12000 = 13 200 000; duty 10% = 1 320 000.
    expect(r.lines[0]).toMatchObject({ customsValue: 13_200_000, duty: 1_320_000, customsFee: 250_000 });
    expect(r.lines[0].vat).toBe(1_742_400);
    expect(r.lines[0].cost).toBe(14_770_000);
    expect(r.lines[0].unitCost).toBe(1_477_000);
    expect(r.lines[1].customsValue).toBe(39_600_000);
    expect(r.totals.duty).toBe(1_320_000);
    expect(r.lines.reduce((n: number, l: any) => n + l.customsFee, 0)).toBe(1_000_000);
  });

  it("puts the import VAT into the cost when it cannot be recovered", () => {
    const r = run({
      op: "landed_cost",
      rate: 1,
      items: [{ name: "A", value: 100 }],
      vatRate: 12,
      vatRecoverable: false,
    });
    expect(r.lines[0].cost).toBe(112);
  });
});

describe("penalty", () => {
  it("per day on the principal for the days between two dates, capped", () => {
    const r = run({ op: "penalty", principal: 1_000_000, from: "2026-01-01", to: "2026-04-11" });
    expect(r.days).toBe(100);
    expect(r.penalty).toBe(33_000);
    const capped = run({ op: "penalty", principal: 1_000, days: 5_000, capPercent: 100 });
    expect(capped).toMatchObject({ penalty: 1_000, capped: true });
  });
});

describe("ratios and break_even", () => {
  it("computes only the ratios the figures allow", () => {
    const r = run({
      op: "ratios",
      currentAssets: 500,
      currentLiabilities: 250,
      inventory: 100,
      revenue: 1_000,
      cogs: 600,
      netIncome: 100,
      equity: 400,
      receivables: 100,
    });
    expect(r.ratios).toMatchObject({
      currentRatio: 2,
      quickRatio: 1.6,
      grossMarginPercent: 40,
      netMarginPercent: 10,
      returnOnEquityPercent: 25,
      receivableDays: 36.5,
    });
    expect(r.ratios.cashRatio).toBeUndefined();
  });

  it("break-even units, rounded up, and for a target profit", () => {
    const r = run({ op: "break_even", fixedCosts: 10_000, price: 50, variableCost: 30, targetProfit: 2_000 });
    expect(r).toMatchObject({
      contributionPerUnit: 20,
      breakEvenUnits: 500,
      breakEvenRevenue: 25_000,
      unitsForTargetProfit: 600,
    });
    expect(run({ op: "break_even", fixedCosts: 1, price: 10, variableCost: 10 }).error).toContain(
      "no break-even",
    );
  });
});

describe("the tool's input", () => {
  it("is checked by operation, and a missing field is named", () => {
    const r = AccountingCalcInput.safeParse({ op: "loan", principal: 1000 });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.map((i) => i.path.join("."))).toEqual(
        expect.arrayContaining(["annualRate", "months", "type"]),
      );
  });
});
