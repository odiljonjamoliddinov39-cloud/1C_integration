import { describe, expect, it } from "vitest";

import { dayStart, limitCredits, weekStart } from "./credit-limits.js";

describe("credit limit windows", () => {
  it("a day starts at midnight Tashkent time (UTC+5)", () => {
    // 2026-11-01 15:30 UTC is 20:30 in Tashkent: the day began at 2026-10-31 19:00 UTC.
    expect(dayStart(new Date("2026-11-01T15:30:00Z")).toISOString()).toBe("2026-10-31T19:00:00.000Z");
    // 2026-11-01 19:30 UTC is 00:30 on the 2nd in Tashkent.
    expect(dayStart(new Date("2026-11-01T19:30:00Z")).toISOString()).toBe("2026-11-01T19:00:00.000Z");
    // Exactly at midnight Tashkent time the new day has begun.
    expect(dayStart(new Date("2026-11-01T19:00:00Z")).toISOString()).toBe("2026-11-01T19:00:00.000Z");
  });

  it("a week starts on Monday at midnight Tashkent time", () => {
    // 2026-11-01 is a Sunday: its week began on Monday 26 October (Tashkent), 2026-10-25 19:00 UTC.
    expect(weekStart(new Date("2026-11-01T15:30:00Z")).toISOString()).toBe("2026-10-25T19:00:00.000Z");
    // Sunday 20:30 in Tashkent is 15:30 UTC; Sunday 19:30 UTC is already Monday 00:30 in Tashkent.
    expect(weekStart(new Date("2026-11-01T19:30:00Z")).toISOString()).toBe("2026-11-01T19:00:00.000Z");
    // A Monday morning belongs to its own week.
    expect(weekStart(new Date("2026-11-02T07:00:00Z")).toISOString()).toBe("2026-11-01T19:00:00.000Z");
    // A Wednesday.
    expect(weekStart(new Date("2026-11-04T10:00:00Z")).toISOString()).toBe("2026-11-01T19:00:00.000Z");
  });

  it("a limit is a share of the monthly credits; 0 means none", () => {
    expect(limitCredits(3_040, 15)).toBe(456);
    expect(limitCredits(3_040, 35)).toBe(1_064);
    expect(limitCredits(500, 15)).toBe(75);
    expect(limitCredits(3_040, 0)).toBeNull();
    expect(limitCredits(0, 15)).toBeNull();
    expect(limitCredits(1_000, 250)).toBe(1_000);
  });
});
