import { describe, expect, it } from "vitest";

import { abs, add, cmp, dec, fixed, mul, mulDiv, plain, round, sub, sum } from "./decimal.js";

const d = (v: string | number) => {
  const x = dec(v);
  if (!x) throw new Error(`not a number: ${v}`);
  return x;
};

describe("exact decimals", () => {
  it.each([
    ["11972.34", "11972.34"],
    ["11 972,34", "11972.34"],
    ["1,030,000.00", "1030000"],
    ["1.030.000,50", "1030000.5"],
    ["1,030,000", "1030000"],
    ["0,25", "0.25"],
    ["-5", "-5"],
    [25000, "25000"],
    [0.1, "0.1"],
  ])("reads %s", (text, expected) => expect(plain(d(text))).toBe(expected));

  it.each(["", "abc", "12.3.4", "—", "1e5x"])("%s is not a number", (text) => expect(dec(text)).toBeNull());
  it("null and undefined are not numbers", () => {
    expect(dec(null)).toBeNull();
    expect(dec(undefined)).toBeNull();
    expect(dec(Number.NaN)).toBeNull();
  });

  it("25 000 × 11 972.34 is 299 308 500 to the last digit, with no float in between", () => {
    expect(fixed(mul(d("25000"), d("11972.34")))).toBe("299308500.00");
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(fixed(add(d("0.1"), d("0.2")), 1)).toBe("0.3");
  });

  it("rounds halves away from zero", () => {
    expect(fixed(round(d("2.345"), 2))).toBe("2.35");
    expect(fixed(round(d("-2.345"), 2))).toBe("-2.35");
    expect(fixed(round(d("2.344"), 2))).toBe("2.34");
    expect(fixed(d("5"), 2)).toBe("5.00");
    expect(fixed(d("0.5"), 0)).toBe("1");
  });

  it("shares a fee in proportion, rounded once", () => {
    expect(fixed(mulDiv(d("1030000"), d("9140"), d("25000"), 2) ?? d("0"))).toBe("376568.00");
    expect(mulDiv(d("1"), d("1"), d("0"), 2)).toBeNull();
    expect(fixed(mulDiv(d("100"), d("1"), d("3"), 2) ?? d("0"))).toBe("33.33");
  });

  it("compares across scales and sums", () => {
    expect(cmp(d("25000.00"), d("25000"))).toBe(0);
    expect(cmp(d("1.5"), d("1.49"))).toBe(1);
    expect(fixed(sum([d("9140"), d("2300.5"), d("0.25")]))).toBe("11440.75");
    expect(fixed(abs(sub(d("1"), d("3.5"))))).toBe("2.50");
  });
});
