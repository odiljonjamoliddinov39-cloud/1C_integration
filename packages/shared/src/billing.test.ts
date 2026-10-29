import { describe, expect, it } from "vitest";

import { YEAR_MONTHS, YEAR_PAID_MONTHS, yearPriceOf } from "./billing.js";

describe("yearPriceOf", () => {
  it("is the monthly price for 10 months (12 for 10)", () => {
    expect(yearPriceOf(590_000)).toBe(5_900_000);
    expect(yearPriceOf(899_000)).toBe(8_990_000);
    expect(YEAR_PAID_MONTHS).toBe(10);
    expect(YEAR_MONTHS).toBe(12);
  });

  it("is nothing for a free plan", () => {
    expect(yearPriceOf(0)).toBe(0);
  });
});
