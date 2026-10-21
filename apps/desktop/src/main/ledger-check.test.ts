import { describe, expect, it } from "vitest";

import { judgeBalances } from "./ledger-check.js";

const row = (code: string, debit: number, credit: number, name = code) => ({ code, name, debit, credit });

describe("balances judged by the program", () => {
  it("finds what an accountant looks for, largest first", () => {
    const out = judgeBalances([
      row("5110", 100, 0),
      row("5210", 0, 5_000),
      row("5710", 2_742_873_478.26, 0),
      row("5715", 0, 2_748_794_908.74),
      row("6410", 58_220_553.45, 0),
      row("6010", 0, 175_598_808.47),
      row("4310", 0, 3_000),
      row("9540", 0, 1_234_078_614.14),
      row("9620", 1_200_455_067.74, 0),
    ]);
    expect(out.findings.map((f) => [f.account, f.balance])).toEqual([
      ["6410", 58_220_553.45],
      ["57xx", -5_921_430.48],
      ["5210", -5_000],
      ["4310", -3_000],
    ]);
    expect(out.findings[1]?.why).toContain("transit accounts do not close");
    expect(out.exchangeDifferences).toEqual({ income: 1_234_078_614.14, expense: 1_200_455_067.74 });
    expect(out.accounts).toBe(9);
  });

  it("says nothing about balances that are as they should be", () => {
    expect(
      judgeBalances([row("5110", 57_892.05, 0), row("6010", 0, 10), row("5710", 5, 5)]).findings,
    ).toEqual([]);
  });

  it("adds the lines of one account together", () => {
    const out = judgeBalances([row("5110", 0, 40), row("5110", 10, 0)]);
    expect(out.findings).toEqual([expect.objectContaining({ account: "5110", balance: -30 })]);
  });
});
