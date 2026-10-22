import { describe, expect, it } from "vitest";

import { reportTables, toCsv } from "./report-tables.js";

const labels = {
  revenue: "Revenue",
  costOfSales: "Cost",
  grossProfit: "Gross profit",
  netProfit: "Net profit",
  receivables: "Receivables",
  result: "Result",
};

describe("the report tables", () => {
  it("makes the result's lines with the accounts they came from, leaving out the empty ones", () => {
    const [t] = reportTables(
      "result",
      {
        revenue: {
          amount: 1_250_000,
          sources: [
            { account: "9010", name: "x", amount: 1_000_000 },
            { account: "9020", name: "y", amount: 250_000 },
          ],
        },
        costOfSales: { amount: 520_000, sources: [] },
        grossProfit: 730_000,
        netProfit: 535_000,
        periodExpenses: { amount: 0, sources: [] },
      },
      labels,
    );
    expect(t?.head).toEqual(["Line", "Amount", "Accounts"]);
    expect(t?.rows).toEqual([
      ["Revenue", "1 250 000", "9010 1 000 000, 9020 250 000"],
      ["Cost", "520 000", ""],
      ["▸ Gross profit", "730 000", ""],
      ["▸ operatingProfit", "0", ""], // a total is always shown, in the screen's words when it has them
      ["▸ profitBeforeTax", "0", ""],
      ["▸ Net profit", "535 000", ""],
    ]);
  });

  it("lists the debtors and the advances apart, and aging with its buckets", () => {
    const t = reportTables(
      "receivables",
      { parties: [{ party: "A", amount: 900 }], advances: [{ party: "B", amount: 300 }] },
      labels,
    );
    expect(t.map((x) => x.rows)).toEqual([[["A", "900"]], [["B", "300"]]]);
    const [aging] = reportTables(
      "aging_receivables",
      { parties: [{ party: "A", total: 800, buckets: [200, 300, 300, 0], oldestDays: 82 }] },
      {},
    );
    expect(aging?.rows).toEqual([["A", "800", "200", "300", "300", "0", "82"]]);
  });

  it("has no table for a report it only tells in words", () => {
    expect(reportTables("tax_accrual", {}, {})).toEqual([]);
  });

  it("makes a CSV Excel opens: semicolons, quotes doubled, a byte-order mark", () => {
    const csv = toCsv([{ title: "T", head: ["A", "B"], rows: [["x;y", 'say "hi"']] }]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"x;y";"say ""hi"""');
  });
});
