import { describe, expect, it } from "vitest";

import { checkCost } from "./stock-cost.js";

const day = (date: string, qtyIn: number, sumIn: number, qtyOut: number, sumOut: number) => ({
  date,
  qtyIn,
  sumIn,
  qtyOut,
  sumOut,
});

describe("checking the cost of issues against the method", () => {
  const moves = [
    day("2026-01-05", 10, 100, 0, 0),
    day("2026-01-10", 10, 200, 0, 0),
    day("2026-01-15", 0, 0, 15, 0),
  ];

  it("FIFO: the issue takes the older lot first", () => {
    const c = checkCost("Rice", [...moves.slice(0, 2), day("2026-01-15", 0, 0, 15, 200)], "fifo");
    expect(c).toMatchObject({
      expected: 200,
      booked: 200,
      difference: 0,
      status: "match",
      closing: { qty: 5 },
    });
  });

  it("average: every unit costs the average of the stock", () => {
    const c = checkCost("Rice", [...moves.slice(0, 2), day("2026-01-15", 0, 0, 15, 225)], "average");
    expect(c).toMatchObject({ expected: 225, difference: 0, status: "match" });
  });

  it("finds a difference between what 1C booked and what the method gives", () => {
    const c = checkCost("Rice", [...moves.slice(0, 2), day("2026-01-15", 0, 0, 15, 190)], "fifo");
    expect(c).toMatchObject({ expected: 200, booked: 190, difference: -10, status: "difference" });
  });

  it("says when more was issued than ever came in, and when nothing was issued", () => {
    expect(
      checkCost("Rice", [day("2026-01-05", 5, 50, 0, 0), day("2026-01-06", 0, 0, 9, 90)], "fifo").status,
    ).toBe("short");
    expect(checkCost("Rice", [day("2026-01-05", 5, 50, 0, 0)], "fifo").status).toBe("no_issues");
  });

  it("a receipt and an issue on one day: the receipt is available to the issue", () => {
    expect(checkCost("Rice", [day("2026-01-05", 5, 50, 5, 50)], "fifo").status).toBe("match");
  });
});
