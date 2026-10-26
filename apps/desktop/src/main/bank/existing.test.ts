import { describe, expect, it } from "vitest";

import { type ExistingDoc, ExistingPool, existingDocs } from "./existing.js";
import type { BankCache, BankDeps } from "./resolve.js";

const doc = (over: Partial<ExistingDoc> = {}): ExistingDoc => ({
  account: "A",
  day: "2024-05-17",
  cents: 108_452,
  counterparty: "TREASURY",
  number: "448113675",
  ...over,
});

describe("what 1C already has of a statement", () => {
  it("a payment with no counterparty of its own (a tax, a fee) is the document of the same account, day and amount", () => {
    const pool = new ExistingPool([doc()]);
    expect(pool.take({ account: "A", day: "2024-05-17", cents: 108_452, counterparty: null })).toBe(true);
    // used up: the second equal row needs its own document
    expect(pool.take({ account: "A", day: "2024-05-17", cents: 108_452, counterparty: null })).toBe(false);
  });

  it("another account, another day, another amount, or another payee under another number is not the same payment", () => {
    const pool = new ExistingPool([doc()]);
    expect(pool.take({ account: "B", day: "2024-05-17", cents: 108_452 })).toBe(false);
    expect(pool.take({ account: "A", day: "2024-05-18", cents: 108_452 })).toBe(false);
    expect(pool.take({ account: "A", day: "2024-05-17", cents: 1 })).toBe(false);
    expect(
      pool.take({ account: "A", day: "2024-05-17", cents: 108_452, counterparty: "OTHER", number: "1" }),
    ).toBe(false);
    // the same bank number is the same row whoever it was written to
    expect(
      pool.take({
        account: "A",
        day: "2024-05-17",
        cents: 108_452,
        counterparty: "OTHER",
        number: "448113675",
      }),
    ).toBe(true);
  });

  it("reads a long period in windows of a quarter, so that no window hides the rest", async () => {
    const asked: string[] = [];
    const deps = {
      describe: async () => ({ ok: true, data: [{ attributes: [] }] }),
      query: async (input: { params?: Record<string, unknown> }) => {
        asked.push(`${input.params?.["начало"]}..${input.params?.["конец"]}`);
        return { ok: true as const, data: { rows: [] } };
      },
    } as unknown as BankDeps;
    const cache: BankCache = { lists: new Map(), snapshots: new Map() };
    const found = await existingDocs(deps, cache, "out", "2024-02-10", "2024-08-20");
    expect(found).toEqual([]);
    expect(asked).toEqual([
      "2024-02-10T00:00:00..2024-03-31T23:59:59",
      "2024-04-01T00:00:00..2024-06-30T23:59:59",
      "2024-07-01T00:00:00..2024-08-20T23:59:59",
    ]);
  });
});
