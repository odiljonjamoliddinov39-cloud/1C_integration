import type { RunQueryInput } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { describeVerdicts, toMemory, verifyPosted } from "./verify.js";
import type { BankDeps } from "./resolve.js";

const OUT = "Документ.СписаниеСРасчетногоСчета";
const doc = (ref: string, kase: string, day = "2025-03-10") => ({ ref, object: OUT, case: kase, day });
const reg = (ref: string) => ({ type: OUT, ref, name: ref });
const op = (name: string) => ({ type: "Перечисление.X", ref: name, name });

/** A 1C whose register holds `entries` ([document, Dt, Kt]) and whose documents carry `operations` ([document, operation]). */
function world(entries: [string, string, string][], operations: [string, string][], fail = false) {
  const asked: RunQueryInput[] = [];
  const deps = {
    query: async (input: RunQueryInput) => {
      asked.push(input);
      if (fail) return { ok: false as const, code: "X", message: "no" };
      if (input.query.includes("РегистрБухгалтерии"))
        return { ok: true as const, data: { rows: entries.map(([d, dt, kt]) => [reg(d), dt, kt]) } };
      return { ok: true as const, data: { rows: operations.map(([d, o]) => [reg(d), op(o)]) } };
    },
  } as unknown as BankDeps;
  return { deps, asked };
}

describe("what 1C posted for the documents the program wrote", () => {
  it("a transfer that credits the bank against the transit is right; one that posts to a receivable, or nothing, is wrong", async () => {
    const w = world(
      [
        ["a", "5710", "5110"],
        ["b", "4220", "5110"],
      ],
      [
        ["a", "Прочее списание"],
        ["b", "Перевод на другой счет организации"],
        ["c", "Перевод на другой счет организации"],
      ],
    );
    const verdicts = await verifyPosted(w.deps, [
      doc("a", "transferOut"),
      doc("b", "transferOut"),
      doc("c", "transferOut"),
    ]);
    expect(verdicts?.map((v) => [v.ref, v.ok])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
    expect(verdicts?.[1]?.problem).toBe("it posted Dt 4220 / Kt 5110");
    expect(verdicts?.[2]?.problem).toBe("it posted no entry");
    expect(verdicts?.[1]?.operation).toBe("Перевод на другой счет организации");
  });

  it("a document with several entries is right when one of them is the case's (a fee with its VAT line)", async () => {
    const w = world(
      [
        ["a", "9430", "5110"],
        ["a", "4410", "5110"],
      ],
      [["a", "Прочее списание"]],
    );
    expect((await verifyPosted(w.deps, [doc("a", "fee")]))?.[0]?.ok).toBe(true);
  });

  it("reads each kind of document once, over the days its documents span", async () => {
    const w = world([["a", "5710", "5110"]], [["a", "Прочее списание"]]);
    await verifyPosted(w.deps, [
      doc("a", "transferOut", "2025-03-10"),
      doc("b", "transferOut", "2025-03-14"),
    ]);
    const register = w.asked.find((q) => q.query.includes("РегистрБухгалтерии"));
    expect(register?.params).toEqual({ начало: "2025-03-10T00:00:00", конец: "2025-03-14T23:59:59" });
    expect(w.asked.filter((q) => q.query.includes("РегистрБухгалтерии"))).toHaveLength(1);
  });

  it("does not judge what it has no sure rule for (a budget payment, cash, plain payments)", async () => {
    const w = world([["a", "6410", "5110"]], [["a", "Уплата налога"]]);
    expect(await verifyPosted(w.deps, [doc("a", "tax"), doc("b", "cashIn"), doc("c", "nonsense")])).toEqual(
      [],
    );
    expect(w.asked).toHaveLength(0);
  });

  it("says nothing when 1C cannot be read", async () => {
    expect(await verifyPosted(world([], [], true).deps, [doc("a", "transferOut")])).toBeNull();
  });
});

describe("what is remembered and what the accountant is told", () => {
  const verdicts = [
    {
      ref: "a",
      object: OUT,
      case: "transferOut" as const,
      operation: "Перевод на другой счет организации",
      ok: false,
      pairs: [],
      problem: "it posted Dt 4220 / Kt 5110",
    },
    {
      ref: "b",
      object: OUT,
      case: "transferOut" as const,
      operation: "Перевод на другой счет организации",
      ok: false,
      pairs: [],
      problem: "it posted no entry",
    },
    {
      ref: "c",
      object: OUT,
      case: "transferOut" as const,
      operation: "Прочее списание",
      ok: true,
      pairs: [],
    },
  ];
  it("counts per operation and case, keeping the last wrong entry", () => {
    const memory = toMemory(verdicts);
    expect(memory).toHaveLength(2);
    expect(memory.find((m) => m.operation === "Перевод на другой счет организации")).toMatchObject({
      case: "transferOut",
      good: 0,
      bad: 2,
      lastBad: "it posted no entry",
    });
    expect(memory.find((m) => m.operation === "Прочее списание")).toMatchObject({ good: 1, bad: 0 });
  });
  it("a document whose operation could not be read is judged but not remembered", () => {
    expect(toMemory([{ ...verdicts[0]!, operation: "" }])).toEqual([]);
  });
  it("names the operation that went wrong, how many documents and what they posted", () => {
    const lines = describeVerdicts(verdicts);
    expect(lines[0]).toBe("1 of 3 posted documents made the entry their case needs");
    expect(lines[1]).toContain(
      "«Перевод на другой счет организации» as transferOut: 2 document(s) went wrong",
    );
    expect(lines[1]).toContain("will not use this operation for this case again");
  });
});
