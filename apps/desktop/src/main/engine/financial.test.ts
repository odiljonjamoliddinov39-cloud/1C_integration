import { describe, expect, it } from "vitest";

import { buildBalance, buildDebts, buildResult, buildStock } from "./financial.js";

const row = (code: string, debit: number, credit: number, name = code) => ({ code, name, debit, credit });

describe("the financial result", () => {
  const turnovers = [
    row("9010", 0, 1_000_000, "Sales of finished products"),
    row("9020", 50_000, 300_000, "Sales of goods"), // returns of 50 000
    row("9110", 400_000, 0),
    row("9120", 120_000, 0),
    row("9410", 80_000, 0),
    row("9420", 60_000, 0),
    row("9540", 0, 20_000, "Exchange gain"),
    row("9620", 5_000, 0, "Exchange loss"),
    row("9810", 70_000, 0, "Profit tax"),
    row("001", 999, 0), // off-balance: left out
  ];

  it("goes from revenue to net profit and says which accounts each line is made of", () => {
    const r = buildResult(turnovers, { from: "2026-01-01", to: "2026-06-30" }, "2026-10-22");
    expect(r.revenue.amount).toBe(1_250_000);
    expect(r.revenue.sources.map((s) => s.account)).toEqual(["9010", "9020"]);
    expect(r.revenue.sources[1]?.amount).toBe(250_000); // net of the returns
    expect(r.costOfSales.amount).toBe(520_000);
    expect(r.grossProfit).toBe(730_000);
    expect(r.periodExpenses.amount).toBe(140_000);
    expect(r.operatingProfit).toBe(590_000);
    expect(r.financialIncome.amount).toBe(20_000);
    expect(r.financialExpenses.amount).toBe(5_000);
    expect(r.profitBeforeTax).toBe(605_000);
    expect(r.tax.amount).toBe(70_000);
    expect(r.netProfit).toBe(535_000);
    expect(r.provisional).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it("calls an open period provisional", () => {
    const r = buildResult(turnovers, { from: "2026-10-01", to: "2026-12-31" }, "2026-10-22");
    expect(r.provisional).toBe(true);
    expect(r.findings[0]).toContain("provisional");
  });

  it("counts 93 (other operating income) by its credit side and ignores the final result accounts", () => {
    const r = buildResult(
      [
        row("9010", 0, 1000),
        row("9310", 0, 80, "Other operating income"),
        row("9420", 100, 0),
        row("9910", 0, 5000),
      ],
      { from: "2025-01-01", to: "2025-12-31" },
      "2026-10-22",
    );
    expect(r.otherOperating.amount).toBe(80);
    expect(r.operatingProfit).toBe(980);
    expect(r.netProfit).toBe(980); // 9910 is not part of any line
  });

  it("adds the rows of one account (by currency or organization)", () => {
    const r = buildResult(
      [row("9010", 0, 100), row("9010", 0, 50)],
      { from: "2026-01-01", to: "2026-01-31" },
      "2026-10-22",
    );
    expect(r.revenue.amount).toBe(150);
    expect(r.revenue.sources).toHaveLength(1);
  });
});

describe("the balance", () => {
  const books = [
    row("0100", 500_000, 0, "Fixed assets"),
    row("0200", 0, 100_000, "Depreciation"),
    row("2910", 200_000, 0, "Goods"),
    row("4010", 300_000, 0, "Receivables"),
    row("5110", 250_000, 0, "Bank"),
    row("6010", 0, 250_000, "Payables"),
    row("6410", 0, 50_000, "Budget"),
    row("7000", 0, 100_000, "Long-term loan"),
    row("8300", 0, 500_000, "Charter capital"),
    row("9010", 0, 400_000),
    row("9110", 150_000, 0),
  ];

  it("closes: assets equal liabilities, equity and the profit of the open year", () => {
    const b = buildBalance(books, "2026-06-30", 250_000);
    expect(b.longTermAssets.amount).toBe(400_000); // net of the depreciation
    expect(b.stock.amount).toBe(200_000);
    expect(b.receivables.amount).toBe(300_000);
    expect(b.money.amount).toBe(250_000);
    expect(b.totalAssets).toBe(1_150_000);
    expect(b.currentLiabilities.amount).toBe(300_000);
    expect(b.longTermLiabilities.amount).toBe(100_000);
    expect(b.equity.amount).toBe(500_000);
    expect(b.currentResult.amount).toBe(250_000);
    expect(b.totalLiabilities).toBe(1_150_000);
    expect(b.difference).toBe(0);
    expect(b.balanced).toBe(true);
    expect(b.findings).toEqual([]);
  });

  it("names a difference, and the profit that does not agree with the result", () => {
    const b = buildBalance([...books, row("5510", 10_000, 0)], "2026-06-30", 100_000);
    expect(b.balanced).toBe(false);
    expect(b.difference).toBe(10_000);
    expect(b.findings.map((f) => f.name)).toContain("assets − liabilities and equity");
    expect(b.findings.map((f) => f.name)).toContain("profit in the balance against the financial result");
  });

  it("shows the unusual balances: cash in credit, a liability in debit", () => {
    const b = buildBalance([row("5010", 0, 5_000), row("6010", 7_000, 0)], "2026-06-30");
    expect(b.findings.map((f) => f.account)).toEqual(expect.arrayContaining(["5010", "6010"]));
  });
});

describe("the debts", () => {
  it("lists who owes, biggest first, and keeps the advances apart", () => {
    const d = buildDebts(
      "receivables",
      [
        { party: "A", debit: 500, credit: 0 },
        { party: "B", debit: 900, credit: 100 },
        { party: "C", debit: 0, credit: 300 }, // an advance received
        { party: "A", debit: 0, credit: 100 },
      ],
      "2026-06-30",
    );
    expect(d.parties).toEqual([
      { party: "B", amount: 800 },
      { party: "A", amount: 400 },
    ]);
    expect(d.total).toBe(1200);
    expect(d.advances).toEqual([{ party: "C", amount: 300 }]);
    expect(d.advancesTotal).toBe(300);
  });

  it("reads the payables from the credit side", () => {
    const d = buildDebts("payables", [{ party: "S", debit: 0, credit: 70 }], "2026-06-30");
    expect(d.parties).toEqual([{ party: "S", amount: 70 }]);
  });
});

describe("the stock", () => {
  it("adds up by item and warehouse and finds negative, costless and quantity-less positions", () => {
    const s = buildStock(
      [
        { item: "Rice", warehouse: "Main", qty: 10, amount: 100 },
        { item: "Rice", warehouse: "Main", qty: 5, amount: 50 },
        { item: "Oil", warehouse: "Main", qty: -2, amount: -20 },
        { item: "Salt", warehouse: "Branch", qty: 4, amount: 0 },
        { item: "Tea", warehouse: "Branch", qty: 0, amount: 30 },
      ],
      "2026-06-30",
    );
    expect(s.top[0]).toMatchObject({ item: "Rice", qty: 15, amount: 150 });
    expect(s.total).toBe(160);
    expect(s.negative.map((r) => r.item)).toEqual(["Oil"]);
    expect(s.noCost.map((r) => r.item)).toEqual(["Salt"]);
    expect(s.noQuantity.map((r) => r.item)).toEqual(["Tea"]);
    expect(s.byWarehouse).toEqual([
      { warehouse: "Main", amount: 130 },
      { warehouse: "Branch", amount: 30 },
    ]);
  });
});
