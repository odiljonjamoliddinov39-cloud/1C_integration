import { describe, expect, it } from "vitest";

import { monthEnds, revalue } from "./revaluation.js";

describe("month-end revaluation", () => {
  it("lists the last day of each month, leap years included", () => {
    expect(monthEnds("2024-01-15", "2024-03-02")).toEqual(["2024-01-31", "2024-02-29", "2024-03-31"]);
    expect(monthEnds("2024-11-01", "2025-01-31")).toEqual(["2024-11-30", "2024-12-31", "2025-01-31"]);
  });

  it("says what each balance should be at the rate, and which side to adjust", () => {
    const { found, noRate } = revalue(
      "2024-12-31",
      [
        // an account in dollars: 100 USD carried at 1 270 000 soums, the rate is 12 800
        { account: "5210", currency: "USD", currencyNet: 100, soumNet: 1_270_000 },
        // a dollar advance paid (credit balance of a liability account): 135 774 USD
        { account: "6015", currency: "USD", currencyNet: -100, soumNet: -1_290_000 },
        // correct already
        { account: "5220", currency: "RUB", currencyNet: 1000, soumNet: 130_000 },
        // no rate for it
        { account: "5230", currency: "EUR", currencyNet: 10, soumNet: 1 },
        // a soum account is not revalued
        { account: "5110", currency: "UZS", currencyNet: 5, soumNet: 5 },
      ],
      (currency) => ({ USD: 12_800, RUB: 130 })[currency] ?? null,
    );
    expect(found.map((f) => [f.account, f.expected, f.adjustment])).toEqual([
      ["5210", 1_280_000, 10_000],
      ["6015", -1_280_000, 10_000],
    ]);
    expect(found[0]?.entry).toBe("Дт 5210 / Кт 9540 (exchange gain) 10000");
    expect(noRate).toEqual(["EUR"]);
  });

  it("a liability that grew with the rate is a loss", () => {
    const { found } = revalue(
      "2024-12-31",
      [{ account: "6015", currency: "USD", currencyNet: -100, soumNet: -1_270_000 }],
      () => 12_800,
    );
    expect(found[0]?.adjustment).toBe(-10_000);
    expect(found[0]?.entry).toBe("Дт 9620 (exchange loss) / Кт 6015 10000");
  });
});
