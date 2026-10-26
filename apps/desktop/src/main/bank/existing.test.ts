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

  it("never asks for more than 1000 rows: a period that fills the limit is split until every part fits, and none is hidden", async () => {
    const asked: string[] = [];
    const deps = {
      describe: async () => ({ ok: true, data: [{ attributes: [] }] }),
      query: async (input: { limit?: number; params?: Record<string, unknown> }) => {
        expect(input.limit).toBeLessThanOrEqual(1000);
        const from = String(input.params?.["начало"]).slice(0, 10);
        const to = String(input.params?.["конец"]).slice(0, 10);
        asked.push(`${from}..${to}`);
        // a base with a document on every day: a part of more than 1000 days cannot be answered, a part of 4 days can
        const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
        const rows = Array.from({ length: Math.min(days, 1000) }, (_, n) => [
          null,
          null,
          `${new Date(Date.parse(from) + n * 86_400_000).toISOString().slice(0, 10)}T00:00:00`,
          1,
          "",
        ]);
        return { ok: true as const, data: { rows, truncated: days > 5 } };
      },
    } as unknown as BankDeps;
    const cache: BankCache = { lists: new Map(), snapshots: new Map() };
    const found = await existingDocs(deps, cache, "out", "2024-01-01", "2024-01-20");
    // every part that came back full was split: the parts that were answered are short ones
    expect(asked.length).toBeGreaterThan(3);
    expect(found?.length).toBeGreaterThan(0);
    expect(new Set(found?.map((d) => d.day)).size).toBe(20);
  });
});
