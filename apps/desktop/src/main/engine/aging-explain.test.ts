import { describe, expect, it } from "vitest";

import { ageDebts } from "./aging.js";
import { explainResult, previousPeriod } from "./explain.js";

const e = (party: string, date: string, debit: number, credit: number) => ({ party, date, debit, credit });

describe("aging of receivables", () => {
  it("ages what is left after the payments settled the oldest invoices first", () => {
    const r = ageDebts(
      "receivables",
      [
        e("A", "2026-05-01", 1000, 0), // 174 days old
        e("A", "2026-08-01", 500, 0), // 82 days
        e("A", "2026-09-20", 300, 0), // 32 days
        e("A", "2026-10-10", 200, 0), // 12 days
        e("A", "2026-10-15", 0, 1200), // pays the first invoice and 200 of the second
      ],
      "2026-10-22",
    );
    expect(r.parties[0]).toMatchObject({
      party: "A",
      total: 800,
      buckets: [200, 300, 300, 0],
      oldestDays: 82,
    });
    expect(r.total).toBe(800);
    expect(r.overdue).toBe(600);
  });

  it("keeps money received before an invoice as an advance, and uses it against the next invoice", () => {
    const r = ageDebts(
      "receivables",
      [e("B", "2026-10-01", 0, 400), e("C", "2026-10-02", 0, 50), e("B", "2026-10-05", 300, 0)],
      "2026-10-22",
    );
    expect(r.parties.find((p) => p.party === "B")).toBeUndefined();
    expect(r.advances).toEqual([
      { party: "B", amount: 100 },
      { party: "C", amount: 50 },
    ]);
    expect(r.advancesTotal).toBe(150);
  });

  it("payables run the other way: the credit opens, the debit settles", () => {
    const r = ageDebts(
      "payables",
      [e("S", "2026-07-01", 0, 900), e("S", "2026-10-01", 400, 0)],
      "2026-10-22",
    );
    expect(r.parties[0]).toMatchObject({ party: "S", total: 500, buckets: [0, 0, 0, 500] });
  });

  it("ignores entries after the date and settles a same-day payment", () => {
    const r = ageDebts(
      "receivables",
      [e("D", "2026-10-22", 100, 100), e("D", "2026-11-01", 999, 0)],
      "2026-10-22",
    );
    expect(r.total).toBe(0);
    expect(r.parties).toEqual([]);
  });
});

describe("what moved the result", () => {
  const now = [
    { account: "9010", who: "Alpha", debit: 0, credit: 700 },
    { account: "9010", who: "Beta", debit: 50, credit: 300 },
    { account: "9110", who: "Rice", debit: 400, credit: 0 },
    { account: "9420", who: "Rent", debit: 100, credit: 0 },
    { account: "001", who: "x", debit: 5, credit: 0 },
  ];
  const before = [
    { account: "9010", who: "Alpha", debit: 0, credit: 400 },
    { account: "9010", who: "Gamma", debit: 0, credit: 200 },
  ];

  it("lists the biggest drivers of each group with their share", () => {
    const out = explainResult(now);
    const revenue = out.find((g) => g.group === "revenue")!;
    expect(revenue.total).toBe(950);
    expect(revenue.drivers.map((d) => [d.who, d.amount])).toEqual([
      ["Alpha", 700],
      ["Beta", 250],
    ]);
    expect(revenue.drivers[0]?.share).toBeCloseTo(73.68, 1);
    expect(out.map((g) => g.group)).toEqual(["revenue", "costOfSales", "periodExpenses"]);
  });

  it("against the earlier period, shows what changed, including who dropped out", () => {
    const revenue = explainResult(now, before).find((g) => g.group === "revenue")!;
    expect(revenue.totalBefore).toBe(600);
    expect(revenue.drivers.find((d) => d.who === "Alpha")).toMatchObject({ before: 400, change: 300 });
    expect(revenue.drivers.find((d) => d.who === "Gamma")).toMatchObject({ amount: 0, change: -200 });
  });

  it("takes the period of the same length before this one", () => {
    expect(previousPeriod("2026-04-01", "2026-06-30")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(previousPeriod("2026-01-01", "2026-01-31")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});
