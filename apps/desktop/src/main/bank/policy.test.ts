import { describe, expect, it } from "vitest";

import type { RunQueryInput } from "@platform/shared";

import type { QueryOutcome, ResolverDeps } from "../didox/resolve.js";
import { type LedgerPlan } from "./ledger.js";
import { PolicyMemory, describePolicy, learnPolicy, purposeOf, reflectOnImport } from "./policy.js";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
const ok = (rows: unknown[][]): QueryOutcome => ({ ok: true, data: { columns: [], rows, truncated: false } });
const fail: QueryOutcome = { ok: false, code: "QUERY_ERROR", message: "no such object" };

const MAIN = ref("Справочник.БанковскиеСчета", "aaaaaaaa-0000-4000-8000-000000000001", "Асосий хисоб рақам");
const BLOCK = ref("Справочник.БанковскиеСчета", "aaaaaaaa-0000-4000-8000-000000000002", "Блок счет");
const USD = ref("Справочник.БанковскиеСчета", "aaaaaaaa-0000-4000-8000-000000000003", "USD хисоб рақам");

const OUT = (name: string, id: string) => ref("Перечисление.ВидыОперацийСписаниеДенежныхСредств", id, name);

/** A 1C that answers by what the query reads. */
function fake(over: (q: RunQueryInput) => QueryOutcome | undefined = () => undefined): ResolverDeps & {
  queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    async query(input) {
      queries.push(input.query);
      const custom = over(input);
      if (custom) return custom;
      const q = input.query;
      if (q.includes("Справочник.БанковскиеСчета"))
        return ok([
          [MAIN, "20208000100438330001", "Асосий хисоб рақам", "UZS", "5110", "201607534"],
          [BLOCK, "20208000800438330009", "Блок счет", "UZS", "5530", "201607534"],
          [USD, "20208840100438330002", "USD хисоб рақам", "USD", "5210", "201607534"],
          [
            ref("Справочник.БанковскиеСчета", "aaaaaaaa-0000-4000-8000-000000000009", "чужой"),
            "20208000100000000001",
            "чужой",
            "UZS",
            "",
            "999999999",
          ],
        ]);
      if (q.includes("Документ.СписаниеСРасчетногоСчета") && q.includes("СГРУППИРОВАТЬ"))
        return ok([
          [
            MAIN,
            OUT("Оплата поставщику", "ОплатаПоставщику"),
            120,
            "2024-01-09T00:00:00",
            "2026-09-30T00:00:00",
          ],
          [
            MAIN,
            OUT("Перевод на другой счет организации", "ПереводНаДругойСчет"),
            14,
            "2024-03-01T00:00:00",
            "2026-08-12T00:00:00",
          ],
          [
            BLOCK,
            OUT("Перевод на другой счет организации", "ПереводНаДругойСчет"),
            3,
            "2025-02-01T00:00:00",
            "2026-05-04T00:00:00",
          ],
        ]);
      if (q.includes("Документ.ПоступлениеНаРасчетныйСчет") && q.includes("СГРУППИРОВАТЬ"))
        return ok([
          [
            MAIN,
            ref("Перечисление.ВидыОперацийПоступлениеДенежныхСредств", "x", "Оплата от покупателя"),
            80,
            "2024-01-02T00:00:00",
            "2026-09-29T00:00:00",
          ],
        ]);
      if (q.includes("ИЗ Документ.РеализацияТоваровУслуг")) return ok([[210, "2026-09-30T00:00:00"]]);
      if (q.includes("ИЗ Документ.ПоступлениеТоваровУслуг")) return ok([[95, "2026-09-28T00:00:00"]]);
      if (q.includes("ССЫЛКА Документ.ПоступлениеТоваровУслуг"))
        return ok([
          ["2910", "6010", 120],
          ["4410", "6010", 118],
        ]);
      if (q.includes("ССЫЛКА Документ.РеализацияТоваровУслуг")) return ok([["4010", "9020", 200]]);
      if (q.includes("Хозрасчетный") && q.includes("СчетДт"))
        return ok([
          ["5110", 400],
          ["6010", 300],
        ]);
      if (q.includes("Хозрасчетный") && q.includes("СчетКт"))
        return ok([
          ["6010", 380],
          ["4010", 220],
        ]);
      if (q.includes("ДоговорыКонтрагентов"))
        return ok([
          ["UZS", 300],
          ["USD", 12],
        ]);
      return fail;
    },
    async describe() {
      return fail;
    },
  };
}

describe("purposeOf", () => {
  it("tells a blocked account, a foreign-currency one and the main one apart", () => {
    const base = {
      number: "20208000100438330001",
      currency: "UZS",
      ledger: "5110",
      name: "Асосий хисоб рақам",
    };
    expect(purposeOf(base)).toBe("main");
    expect(purposeOf({ ...base, name: "Блок счет", ledger: "5530" })).toBe("blocked");
    expect(purposeOf({ ...base, name: "USD хисоб рақам", currency: "USD", ledger: "5210" })).toBe("foreign");
    expect(purposeOf({ ...base, name: "Хт Харид", ledger: "" })).toBe("other");
  });

  it("takes the currency from the account number when 1C keeps none", () => {
    expect(purposeOf({ number: "20208643100438330002", currency: "", ledger: "", name: "x" })).toBe(
      "foreign",
    );
  });
});

describe("learnPolicy", () => {
  it("reads the company's own accounts with what each is used for, the kinds of operation and the activity", async () => {
    const policy = await learnPolicy(fake(), "201607534");
    expect(policy.accounts.map((a) => [a.name, a.purpose])).toEqual([
      ["Асосий хисоб рақам", "main"],
      ["Блок счет", "blocked"],
      ["USD хисоб рақам", "foreign"],
    ]);
    expect(policy.accounts[0]!.uses[0]).toMatchObject({ kind: "Оплата поставщику", count: 120 });
    const transfer = policy.kinds.find((k) => k.transfer)!;
    expect(transfer).toMatchObject({
      kind: "Перевод на другой счет организации",
      count: 17,
      first: "2024-03-01",
      last: "2026-08-12",
    });
    expect(policy.activity.map((a) => a.object)).toEqual([
      "РеализацияТоваровУслуг",
      "ПоступлениеТоваровУслуг",
    ]);
    expect(policy.postings[0]).toEqual({ code: "6010", debit: 300, credit: 380 });
    // How its documents are booked: the company's own formulas.
    expect(policy.patterns).toEqual([
      { object: "РеализацияТоваровУслуг", pairs: [{ debit: "4010", credit: "9020", count: 200 }] },
      {
        object: "ПоступлениеТоваровУслуг",
        pairs: [
          { debit: "2910", credit: "6010", count: 120 },
          { debit: "4410", credit: "6010", count: 118 },
        ],
      },
    ]);
    expect(policy.currencies).toEqual([
      { currency: "UZS", contracts: 300 },
      { currency: "USD", contracts: 12 },
    ]);
    expect(policy.gaps).toEqual([]);
  });

  it("keeps going when a read fails, and says what it could not read", async () => {
    const policy = await learnPolicy(
      fake((q) => (q.query.includes("СписаниеСРасчетногоСчета") ? fail : undefined)),
      "201607534",
    );
    expect(policy.accounts).toHaveLength(3);
    expect(policy.gaps).toEqual([expect.stringContaining("payments out")]);
    expect(policy.activity.length).toBeGreaterThan(0);
  });

  it("falls back to a query without the ledger account when the catalog has no such attribute", async () => {
    let first = true;
    const deps = fake((q) => {
      if (q.query.includes("Справочник.БанковскиеСчета") && q.query.includes("СчетБУ.Код")) {
        first = false;
        return fail;
      }
      return undefined;
    });
    const policy = await learnPolicy(deps, "201607534");
    expect(first).toBe(false);
    expect(policy.accounts).toHaveLength(3);
    expect(
      deps.queries.some((q) => q.includes("Справочник.БанковскиеСчета") && !q.includes("СчетБУ.Код")),
    ).toBe(true);
  });

  it("reads the newest record of the accounting policy register when the configuration has one", async () => {
    const deps = fake((q) =>
      q.query.includes("УчетнаяПолитикаОрганизаций") ? ok([["Метод ФИФО", true, 12]]) : undefined,
    );
    deps.describe = async (objects) =>
      objects[0] === "РегистрСведений.УчетнаяПолитикаОрганизаций"
        ? {
            ok: true,
            data: [
              {
                attributes: [],
                resources: [
                  { name: "МетодОценки", synonym: "Метод оценки" },
                  { name: "ПлательщикНДС", synonym: "Плательщик НДС" },
                  { name: "СтавкаНДС", synonym: "Ставка НДС" },
                ],
                dimensions: [{ name: "Организация", synonym: "Организация" }],
              },
            ],
          }
        : fail;
    const policy = await learnPolicy(deps, "201607534");
    expect(policy.record).toEqual({
      object: "РегистрСведений.УчетнаяПолитикаОрганизаций",
      fields: [
        { name: "Метод оценки", value: "Метод ФИФО" },
        { name: "Плательщик НДС", value: "true" },
        { name: "Ставка НДС", value: "12" },
      ],
    });
  });
});

describe("describePolicy", () => {
  it("lists the accounts, how own transfers are recorded, the activity, the postings and the contract currencies", async () => {
    const text = describePolicy(await learnPolicy(fake(), "201607534"));
    expect(text).toContain("«Блок счет» (UZS, ledger 5530) blocked / held-money account");
    expect(text).toContain(
      "Moves between its own accounts and conversions are recorded as: «Перевод на другой счет организации» (out, 17 documents",
    );
    expect(text).toContain("РеализацияТоваровУслуг ×210");
    expect(text).toContain("6010 300/380");
    expect(text).toContain("- ПоступлениеТоваровУслуг: 2910→6010 ×120; 4410→6010 ×118");
    expect(text).toContain("copy these, do not work the accounts out");
    expect(text).toContain("USD ×12");
    expect(text).toContain("No accounting policy register was found");
  });

  it("says when 1C has never recorded a transfer between its own accounts", async () => {
    const deps = fake((q) =>
      q.query.includes("СписаниеСРасчетногоСчета") && q.query.includes("СГРУППИРОВАТЬ")
        ? ok([
            [
              MAIN,
              OUT("Оплата поставщику", "ОплатаПоставщику"),
              5,
              "2026-01-01T00:00:00",
              "2026-02-01T00:00:00",
            ],
          ])
        : undefined,
    );
    expect(describePolicy(await learnPolicy(deps, "201607534"))).toContain(
      "1C has no posted document of a transfer",
    );
  });
});

describe("reflectOnImport", () => {
  const plan = (over: Partial<LedgerPlan> = {}): LedgerPlan => ({
    accounts: [],
    checks: [],
    rows: new Map(),
    fees: new Map(),
    mismatched: [],
    transfers: [],
    outsidePeriod: 0,
    inPassThrough: 0,
    ...over,
  });
  const view = (account: string, role: LedgerPlan["accounts"][number]["role"] = "settlement") => ({
    file: `${account}.xlsx`,
    account,
    currency: account.slice(5, 8) === "840" ? "USD" : "UZS",
    role,
    reason: "",
    payments: 5,
    inPeriod: 5,
    toEnter: 5,
    fees: 0,
    transfers: 0,
  });
  const transfer = (kind: "own_account" | "conversion") => ({
    kind,
    date: "2026-09-01",
    amount: 100,
    fromAccount: "20208000100438330001",
    toAccount: "20208000800438330009",
    purpose: "",
    out: null,
    in: null,
  });

  it("names a statement account that 1C does not have", async () => {
    const policy = await learnPolicy(fake(), "201607534");
    const lines = reflectOnImport(policy, plan({ accounts: [view("20208000100000099999")] }));
    expect(lines).toEqual([expect.stringContaining("has no bank account in 1C")]);
  });

  it("says how 1C records own transfers and conversions, and that the program enters them from the last such document", async () => {
    const policy = await learnPolicy(fake(), "201607534");
    const lines = reflectOnImport(
      policy,
      plan({
        accounts: [view("20208000100438330001")],
        transfers: [transfer("own_account"), transfer("conversion"), transfer("conversion")],
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("own accounts (1) and conversions (2)");
    expect(lines[0]).toContain("«Перевод на другой счет организации»");
    expect(lines[0]).toContain("enters them as a pair of documents");
  });

  it("says that nothing is known when 1C never recorded such money", async () => {
    const deps = fake((q) =>
      q.query.includes("СписаниеСРасчетногоСчета") && q.query.includes("СГРУППИРОВАТЬ") ? ok([]) : undefined,
    );
    const policy = await learnPolicy(deps, "201607534");
    const lines = reflectOnImport(policy, plan({ transfers: [transfer("own_account")] }));
    expect(lines[0]).toContain("1C has no earlier document of such money");
  });

  it("does not take 1C's code for the sum (860) or the name (сум) for a currency that disagrees", async () => {
    for (const code of ["860", "сум", "UZS"]) {
      const policy = await learnPolicy(
        fake((q) =>
          q.query.includes("Справочник.БанковскиеСчета")
            ? ok([[MAIN, "20208000100438330001", "Асосий", code, "5110", "201607534"]])
            : undefined,
        ),
        "201607534",
      );
      expect(policy.accounts[0]).toMatchObject({ currency: "UZS", purpose: "main" });
      expect(reflectOnImport(policy, plan({ accounts: [view("20208000100438330001")] }))).toEqual([]);
    }
  });

  it("warns about a currency that disagrees with 1C", async () => {
    const policy = await learnPolicy(
      fake((q) =>
        q.query.includes("Справочник.БанковскиеСчета")
          ? ok([[MAIN, "20208840100438330001", "Асосий", "UZS", "5110", "201607534"]])
          : undefined,
      ),
      "201607534",
    );
    const lines = reflectOnImport(policy, plan({ accounts: [view("20208840100438330001")] }));
    expect(lines[0]).toContain("is in USD by its number, but 1C keeps it in UZS");
  });
});

describe("PolicyMemory", () => {
  const learned = () => learnPolicy(fake(), "201607534");

  it("learns once and keeps it, learns again when forced", async () => {
    const memory = new PolicyMemory();
    let runs = 0;
    const learn = () => {
      runs += 1;
      return learned();
    };
    const first = await memory.get("c", learn);
    await memory.get("c", learn);
    expect(runs).toBe(1);
    expect(first.text).toContain("Блок счет");
    await memory.get("c", learn, true);
    expect(runs).toBe(2);
  });

  it("shares a learning that is under way", async () => {
    const memory = new PolicyMemory();
    let runs = 0;
    const learn = () => {
      runs += 1;
      return learned();
    };
    await Promise.all([memory.get("c", learn), memory.get("c", learn)]);
    expect(runs).toBe(1);
  });

  it("keeps nothing when 1C did not answer, and tries again next time", async () => {
    const memory = new PolicyMemory();
    let runs = 0;
    const none = () => {
      runs += 1;
      return learnPolicy({ query: async () => fail, describe: async () => fail }, "201607534");
    };
    expect((await memory.get("c", none)).policy?.accounts).toEqual([]);
    await memory.get("c", none);
    expect(runs).toBe(2);
  });

  it("gives nothing, and does not wait for ever, when 1C is slow", async () => {
    const memory = new PolicyMemory(1000, 10);
    const slow = () => new Promise<never>(() => undefined);
    expect(await memory.get("c", slow)).toEqual({ policy: null, text: "" });
  });
});
