import { describe, expect, it } from "vitest";

import { allocate, allocateCharges } from "./allocate.js";
import { type Dec, dec, fixed, sum } from "./decimal.js";

const d = (v: string) => dec(v) as Dec;

describe("sharing a fee over the items by value", () => {
  it("1,030,000 over 25,000 USD: item 1 (9,140) gets 376,568.00 and item 2 (2,300) gets 94,760.00", () => {
    const a = allocate(d("1030000"), [
      { no: 1, value: d("9140") },
      { no: 2, value: d("2300") },
      { no: 3, value: d("13560") },
    ]);
    expect(fixed(a?.shares[0]?.amount ?? d("0"))).toBe("376568.00");
    expect(fixed(a?.shares[1]?.amount ?? d("0"))).toBe("94760.00");
    expect(fixed(sum(a?.shares.map((s) => s.amount) ?? []))).toBe("1030000.00");
  });

  it("the rounding remainder goes to the item with the largest value, and the shares add up exactly", () => {
    const a = allocate(d("100"), [
      { no: 1, value: d("1") },
      { no: 2, value: d("1") },
      { no: 3, value: d("1") },
    ]);
    // 33.33 × 3 = 99.99: the missing 0.01 goes to the first of the equal items.
    expect(a?.shares.map((s) => fixed(s.amount))).toEqual(["33.34", "33.33", "33.33"]);
    expect(a?.remainderItem).toBe(1);
    expect(fixed(sum(a?.shares.map((s) => s.amount) ?? []))).toBe("100.00");
    const b = allocate(d("100"), [
      { no: 1, value: d("1") },
      { no: 2, value: d("5") },
      { no: 3, value: d("1") },
    ]);
    expect(b?.remainderItem === null || b?.remainderItem === 2).toBe(true);
    expect(fixed(sum(b?.shares.map((s) => s.amount) ?? []))).toBe("100.00");
  });

  it("a remainder can be negative (rounding up too far)", () => {
    const a = allocate(d("1"), [
      { no: 1, value: d("1") },
      { no: 2, value: d("1") },
      { no: 3, value: d("1") },
      { no: 4, value: d("1") },
      { no: 5, value: d("1") },
      { no: 6, value: d("1") },
      { no: 7, value: d("1") },
    ]);
    expect(fixed(sum(a?.shares.map((s) => s.amount) ?? []))).toBe("1.00");
  });

  it("nothing to share over is null", () => {
    expect(allocate(d("100"), [])).toBeNull();
    expect(allocate(d("100"), [{ no: 1, value: d("0") }])).toBeNull();
  });

  it("a fee on an item's own sheet belongs to that item alone", () => {
    const r = allocateCharges(
      [
        { amount: d("100"), itemNo: null },
        { amount: d("50"), itemNo: 2 },
      ],
      [
        { no: 1, value: d("1") },
        { no: 2, value: d("1") },
      ],
    );
    expect(r?.perItem.map((s) => fixed(s.amount))).toEqual(["50.00", "100.00"]);
    expect(fixed(r?.total ?? d("0"))).toBe("150.00");
    expect(allocateCharges([{ amount: d("5"), itemNo: 9 }], [{ no: 1, value: d("1") }])).toBeNull();
  });
});
