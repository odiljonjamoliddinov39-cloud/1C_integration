import { describe, expect, it } from "vitest";

import {
  EMPTY_MEMORY,
  type OperationMemory,
  type OperationProfile,
  avoided,
  chooseOperation,
  counterAccountFrom,
  familyOf,
  fits,
  meaningOf,
  operationProfiles,
  specificOperation,
  verdictKey,
} from "./operations.js";
import type { BankCache, BankDeps } from "./resolve.js";
import type { EnumValue } from "./scaffold.js";

const OUT = "Документ.СписаниеСРасчетногоСчета";
const IN = "Документ.ПоступлениеНаРасчетныйСчет";
const value = (name: string): EnumValue => ({ type: "Перечисление.X", ref: name.replace(/\s/g, ""), name });
const OUT_VALUES = [
  "Оплата поставщику",
  "Перевод на другой счет организации",
  "Прочее списание",
  "Уплата налога",
  "Уплата налога за третьих лиц",
].map(value);
const IN_VALUES = [
  "Оплата покупателя",
  "Перевод с другого счета организации",
  "Прочее поступление",
  "Приобретение иностранной валюты",
  "Продажа иностранной валюты",
].map(value);

const profile = (operation: string, pairs: [string, string, number][]): OperationProfile => ({
  operation,
  ref: operation.replace(/\s/g, ""),
  type: "Перечисление.X",
  pairs: pairs.map(([debit, credit, count]) => ({ debit, credit, count })),
  total: pairs.reduce((n, p) => n + p[2], 0),
});

describe("the kind of an account", () => {
  it.each([
    ["5010", "cash"],
    ["5110", "bank"],
    ["5210", "bank"],
    ["5530", "bank"],
    ["5710", "transit"],
    ["5730", "transit"],
    ["4010", "customer"],
    ["6010", "supplier"],
    ["6015", "supplier"],
    ["6410", "tax"],
    ["4420.1", "tax"],
    ["8330", "capital"],
    ["9430", "expense"],
    ["1010", "other"],
  ])("%s is %s", (code, family) => expect(familyOf(code)).toBe(family));
});

describe("what the entries of a case look like", () => {
  it("a transfer paid out credits the company's bank account against the transit (or another bank account)", () => {
    expect(fits("transferOut", { debit: "5710", credit: "5110" })).toBe(true);
    expect(fits("transferOut", { debit: "5530", credit: "5110" })).toBe(true);
    expect(fits("transferOut", { debit: "4220", credit: "5110" })).toBe(false);
    expect(fits("transferOut", { debit: "5110", credit: "5710" })).toBe(false);
  });
  it("made from the description the other side must be the transit: a bank account cannot be the header's account", () => {
    expect(fits("transferOut", { debit: "5530", credit: "5110" }, ["transit"])).toBe(false);
    expect(fits("transferOut", { debit: "5710", credit: "5110" }, ["transit"])).toBe(true);
  });
  it("a fee debits an expense account, a receipt of a transfer debits the bank account", () => {
    expect(fits("fee", { debit: "9430", credit: "5110" })).toBe(true);
    expect(fits("fee", { debit: "5710", credit: "5110" })).toBe(false);
    expect(fits("transferIn", { debit: "5530", credit: "5710" })).toBe(true);
  });
});

describe("the meaning of an operation's name", () => {
  it("a move: «Прочее списание» to the transit comes before the form's «Перевод»", () => {
    expect(meaningOf("transferOut", "Прочее списание")).toBeGreaterThan(
      meaningOf("transferOut", "Перевод на другой счет организации") ?? 0,
    );
  });
  it("what cannot be it is null: a supplier's payment is not a transfer", () => {
    expect(meaningOf("transferOut", "Оплата поставщику")).toBeNull();
    expect(meaningOf("tax", "Уплата налога за третьих лиц")).toBeNull();
    expect(meaningOf("transferIn", "Оплата покупателя")).toBeNull();
  });
  it("the receiving leg of a currency purchase is «Приобретение иностранной валюты», of a sale it is not", () => {
    expect(meaningOf("conversionIn", "Приобретение иностранной валюты", "buy")).toBe(5);
    expect(meaningOf("conversionIn", "Приобретение иностранной валюты", "sell")).toBeNull();
    expect(meaningOf("conversionIn", "Продажа иностранной валюты", "sell")).toBeGreaterThan(0);
    expect(meaningOf("conversionIn", "Продажа иностранной валюты", "buy")).toBeNull();
  });
  it("other languages", () => {
    expect(meaningOf("transferOut", "Boshqa chiqim")).toBe(3);
    expect(meaningOf("fee", "Бошқа чиқим")).toBe(3);
  });
});

describe("choosing the operation", () => {
  const choose = (over: Partial<Parameters<typeof chooseOperation>[0]> = {}) =>
    chooseOperation({
      kind: "transferOut",
      object: OUT,
      values: OUT_VALUES,
      profiles: null,
      memory: EMPTY_MEMORY,
      ...over,
    });

  it("with no books to look at it goes by the name: «Прочее списание»", () => {
    const c = choose();
    expect(c.ok && c.value.name).toBe("Прочее списание");
    expect(c.ok && c.source).toBe("meaning");
  });

  it("the company's books weigh above a name: an operation named in another language that moves money through the transit", () => {
    const values = [value("Boshqa hisobga"), value("Оплата поставщику")];
    const c = choose({ values, profiles: [profile("Boshqa hisobga", [["5710", "5110", 40]])] });
    expect(c.ok && c.value.name).toBe("Boshqa hisobga");
    expect(c.ok && c.source).toBe("history");
  });

  it("an operation of a form is not made from the description unless the books show it posting through the transit", () => {
    const values = [value("Перевод на другой счет организации"), value("Оплата поставщику")];
    expect(choose({ values }).ok).toBe(false);
    expect(
      choose({ values, profiles: [profile("Перевод на другой счет организации", [["5530", "5110", 12]])] })
        .ok,
    ).toBe(false);
    const through = choose({
      values,
      profiles: [profile("Перевод на другой счет организации", [["5710", "5110", 12]])],
    });
    expect(through.ok && through.value.name).toBe("Перевод на другой счет организации");
  });

  it("an operation the company uses for fees only is still usable for a move (its name says so)", () => {
    const c = choose({ profiles: [profile("Прочее списание", [["9430", "5110", 200]])] });
    expect(c.ok && c.value.name).toBe("Прочее списание");
  });

  it("the accountant's decision comes first, whatever the books say", () => {
    const memory: OperationMemory = {
      choices: [{ case: "transferOut", operation: "Оплата поставщику" }],
      verdicts: [],
    };
    const c = choose({ memory, profiles: [profile("Прочее списание", [["5710", "5110", 90]])] });
    expect(c.ok && c.value.name).toBe("Оплата поставщику");
    expect(c.ok && c.source).toBe("accountant");
  });

  it("an operation seen posting wrong entries is not chosen again for that case", () => {
    const memory: OperationMemory = {
      choices: [],
      verdicts: [
        {
          key: verdictKey(OUT, "transferOut", "Прочее списание"),
          case: "transferOut",
          operation: "Прочее списание",
          good: 0,
          bad: 3,
          lastBad: "Dt 4220 / Kt 5110",
        },
      ],
    };
    expect(avoided(memory, OUT, "transferOut", "Прочее списание")).toBe(true);
    expect(avoided(memory, OUT, "fee", "Прочее списание")).toBe(false);
    expect(choose({ memory }).ok).toBe(false);
    // The same operation for a fee is unaffected.
    expect(choose({ kind: "fee", memory }).ok).toBe(true);
  });

  it("an operation that has also posted right is not given up for one wrong document", () => {
    const memory: OperationMemory = {
      choices: [],
      verdicts: [
        {
          key: verdictKey(OUT, "transferOut", "Прочее списание"),
          case: "transferOut",
          operation: "Прочее списание",
          good: 20,
          bad: 1,
        },
      ],
    };
    expect(avoided(memory, OUT, "transferOut", "Прочее списание")).toBe(false);
  });

  it("the receiving leg of a purchase and of a sale", () => {
    const buy = chooseOperation({
      kind: "conversionIn",
      variant: "buy",
      object: IN,
      values: IN_VALUES,
      profiles: null,
      memory: EMPTY_MEMORY,
    });
    expect(buy.ok && buy.value.name).toBe("Приобретение иностранной валюты");
    const sell = chooseOperation({
      kind: "conversionIn",
      variant: "sell",
      object: IN,
      values: IN_VALUES,
      profiles: null,
      memory: EMPTY_MEMORY,
    });
    expect(sell.ok && sell.value.name).toBe("Продажа иностранной валюты");
  });

  it("nothing fits: says what 1C has and what each posted, so the accountant can name one", () => {
    const c = choose({
      values: [value("Оплата поставщику"), value("Возврат")],
      profiles: [profile("Оплата поставщику", [["6010", "5110", 300]])],
    });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.known).toContain("Оплата поставщику (Dt 6010 / Kt 5110, 300)");
      expect(c.known).toContain("Возврат");
    }
  });
});

describe("the account the other side is booked to", () => {
  it("is the one the company's own documents of the operation use, the most used", () => {
    expect(
      counterAccountFrom("transferOut", [
        { debit: "9430", credit: "5110", count: 500 },
        { debit: "5720", credit: "5110", count: 30 },
        { debit: "5710", credit: "5110", count: 4 },
      ]),
    ).toBe("5720");
    expect(counterAccountFrom("transferOut", [{ debit: "9430", credit: "5110", count: 5 }])).toBeNull();
    expect(counterAccountFrom("transferIn", [{ debit: "5530", credit: "5710", count: 9 }])).toBe("5710");
  });
});

describe("an operation that only does this", () => {
  const memory = EMPTY_MEMORY;
  it("is found when nine entries in ten are such a move", () => {
    const p = [
      profile("Перевод на другой счет организации", [
        ["5530", "5110", 19],
        ["4220", "5110", 1],
      ]),
      profile("Прочее списание", [["9430", "5110", 100]]),
    ];
    expect(specificOperation("transferOut", OUT, p, memory)?.operation).toBe(
      "Перевод на другой счет организации",
    );
    expect(specificOperation("fee", OUT, p, memory)?.operation).toBe("Прочее списание");
    expect(
      specificOperation(
        "transferOut",
        OUT,
        [
          profile("Перевод", [
            ["5530", "5110", 5],
            ["4220", "5110", 5],
          ]),
        ],
        memory,
      ),
    ).toBeNull();
    expect(specificOperation("transferOut", OUT, null, memory)).toBeNull();
  });
});

describe("what each operation posted in this company, read from 1C", () => {
  const cell = (name: string) => ({ type: "Перечисление.X", ref: name, name });
  const world = (rows: unknown[][] | "fail") => {
    let asked = 0;
    const deps = {
      query: async () => {
        asked += 1;
        return rows === "fail"
          ? { ok: false as const, code: "X", message: "no" }
          : { ok: true as const, data: { rows } };
      },
    } as unknown as BankDeps;
    return { deps, asked: () => asked };
  };
  const cache = (): BankCache => ({ lists: new Map(), snapshots: new Map() });

  it("groups the entries by operation, the biggest pair first, and asks once", async () => {
    const w = world([
      [cell("ПрочееСписание"), "9430", "5110", 200],
      [cell("ПрочееСписание"), "5710", "5110", 40],
      [cell("ПереводНаДругойСчет"), "5530", "5110", 12],
    ]);
    const c = cache();
    const list = await operationProfiles(w.deps, c, OUT);
    expect(list).toHaveLength(2);
    expect(list?.[0]).toMatchObject({ ref: "ПрочееСписание", type: "Перечисление.X", total: 240 });
    expect(list?.[0]?.pairs[0]).toEqual({ debit: "9430", credit: "5110", count: 200 });
    await operationProfiles(w.deps, c, OUT);
    expect(w.asked()).toBe(1);
  });

  it("is null when 1C cannot say (the choice then goes by the name)", async () => {
    expect(await operationProfiles(world("fail").deps, cache(), OUT)).toBeNull();
  });
});
