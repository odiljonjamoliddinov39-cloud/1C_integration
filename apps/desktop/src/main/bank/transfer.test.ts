import { describe, expect, it } from "vitest";

import type { RunQueryInput } from "@platform/shared";

import type { Transfer } from "./ledger.js";
import type { BankDeps } from "./resolve.js";
import type { BankPayment, BankStatement } from "./statement.js";
import { resolveTransfers } from "./transfer.js";

const A = "20208000100438330001";
const B = "20208000200438330002";
const REF_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUT_DOC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OUT_OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const IN_DOC = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const USD = "20208840300438330003";
const REF_USD = "99999999-9999-4999-8999-999999999999";
const USD_ITEM = "88888888-8888-4888-8888-888888888888";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
const account = (id: string, name = "р/с") => ref("Справочник.БанковскиеСчета", id, name);

const payment = (over: Partial<BankPayment>): BankPayment => ({
  row: 5,
  date: "2026-09-10",
  number: "77",
  direction: "out",
  amount: 25_000_000,
  counterparty: "CRYSTAL",
  inn: "300000001",
  account: B,
  mfo: "00444",
  purpose: "Перевод между своими счетами",
  ...over,
});

const statement = (fileName: string, acct: string, payments: BankPayment[]): BankStatement => ({
  fileName,
  sheet: "s",
  account: acct,
  payments,
  issues: [],
  columns: {},
  convention: "",
});

const move = (over: Partial<Transfer> = {}): Transfer => ({
  kind: "own_account",
  date: "2026-09-10",
  amount: 25_000_000,
  fromAccount: A,
  toAccount: B,
  purpose: "Перевод между своими счетами",
  out: { file: "a.xlsx", row: 5 },
  in: { file: "b.xlsx", row: 9 },
  ...over,
});

const statements = [
  statement("a.xlsx", A, [payment({ row: 5 })]),
  statement("b.xlsx", B, [payment({ row: 9, direction: "in", account: A })]),
];

/** The earlier transfer document of the company: 1 000 000 from the old account to B. */
const earlier = (object: string, over: Record<string, unknown> = {}) => ({
  fields: {
    Номер: "0000-000003",
    Дата: "2026-08-01T00:00:00",
    Проведен: true,
    ВидОперации: ref(
      object.includes("Списание")
        ? "Перечисление.ВидыОперацийСписаниеДенежныхСредств"
        : "Перечисление.ВидыОперацийПоступлениеДенежныхСредств",
      object.includes("Списание") ? "ПереводНаДругойСчетОрганизации" : "ПереводСДругогоСчетаОрганизации",
      object.includes("Списание")
        ? "Перевод на другой счет организации"
        : "Перевод с другого счета организации",
    ),
    Организация: ref("Справочник.Организации", ORG, "CRYSTAL"),
    БанковскийСчет: account("00000000-0000-4000-8000-000000000001", "старый"),
    СчетПолучатель: account("00000000-0000-4000-8000-000000000002", "старый-2"),
    СуммаДокумента: 1_000_000,
    НазначениеПлатежа: "старое",
    ...over,
  },
  tables: {},
});

interface World {
  docs?: { object: string; ref: string; kind: string; snapshot: ReturnType<typeof earlier> }[];
  accounts?: [string, string][];
  /** account ref, day, amount in soums */
  existing?: [string, string, string, number][];
  kinds?: boolean;
  /** Soums per dollar on the day, when 1C has a rate. */
  rate?: number;
}

function deps(world: World = {}) {
  const seen: RunQueryInput[] = [];
  const docs = world.docs ?? [
    {
      object: "Документ.СписаниеСРасчетногоСчета",
      ref: OUT_DOC,
      kind: "own",
      snapshot: earlier("Документ.СписаниеСРасчетногоСчета"),
    },
    {
      object: "Документ.ПоступлениеНаРасчетныйСчет",
      ref: IN_DOC,
      kind: "own",
      snapshot: earlier("Документ.ПоступлениеНаРасчетныйСчет"),
    },
  ];
  const d: BankDeps = {
    async query(input) {
      seen.push(input);
      const q = input.query;
      const rows = (list: unknown[][]) => ({ ok: true as const, data: { rows: list } });
      const object = q.includes("СписаниеСРасчетногоСчета")
        ? "Документ.СписаниеСРасчетногоСчета"
        : "Документ.ПоступлениеНаРасчетныйСчет";
      if (q.includes("КурсыВалют")) return rows(world.rate ? [[world.rate, 1]] : []);
      if (q.includes("Справочник.Валюты")) return rows([[ref("Справочник.Валюты", USD_ITEM, "Доллар США")]]);
      if (q.includes("Справочник.БанковскиеСчета")) {
        return rows(
          (
            world.accounts ?? [
              [A, REF_A],
              [B, REF_B],
            ]
          ).map(([number, id]) => [number, account(id), "300000001"]),
        );
      }
      if (q.includes("СГРУППИРОВАТЬ ПО Т.ВидОперации")) {
        if (world.kinds === false) return rows([]);
        const enumType = object.includes("Списание")
          ? "Перечисление.ВидыОперацийСписаниеДенежныхСредств"
          : "Перечисление.ВидыОперацийПоступлениеДенежныхСредств";
        return rows([
          [
            ref(
              enumType,
              object.includes("Списание")
                ? "ПереводНаДругойСчетОрганизации"
                : "ПереводСДругогоСчетаОрганизации",
              object.includes("Списание")
                ? "Перевод на другой счет организации"
                : "Перевод с другого счета организации",
            ),
            "2026-08-01T00:00:00",
          ],
          [ref(enumType, "ОплатаПоставщику", "Оплата поставщику"), "2026-09-01T00:00:00"],
          ...(object.includes("Списание")
            ? [[ref(enumType, "ПрочееСписание", "Прочее списание"), "2026-08-15T00:00:00"]]
            : []),
        ]);
      }
      if (q.includes("Т.ВидОперации = ЗНАЧЕНИЕ(")) {
        return rows(docs.filter((x) => x.object === object).map((x) => [ref(x.object, x.ref, "док")]));
      }
      if (q.includes("Т.БанковскийСчет КАК Счет, Т.Дата")) {
        return rows((world.existing ?? []).map(([acct, date, , sum]) => [account(acct), date, sum]));
      }
      return rows([]);
    },
    async describe() {
      return { ok: true, data: [] };
    },
    async getObject(objectName, id) {
      const found = docs.find((x) => x.ref === id && x.object === objectName);
      return found
        ? { ok: true, data: { object: objectName, ref: id, ...found.snapshot } }
        : { ok: false, code: "NOT_FOUND", message: "no such document" };
    },
  };
  return { d, seen };
}

const run = (transfers: Transfer[], world: World = {}, files = ["a.xlsx", "b.xlsx"], done?: Set<string>) =>
  resolveTransfers(
    transfers,
    statements,
    { ownInn: "300000001", files: new Set(files), ...(done ? { done } : {}) },
    deps(world).d,
  );

describe("money moved between the company's own accounts", () => {
  it("is entered as a pair of documents copied from the company's own earlier ones", async () => {
    const out = await run([move()]);
    expect(out.problems).toEqual([]);
    expect(out.ready).toHaveLength(2);
    const [debit, receipt] = out.ready;
    expect(debit).toMatchObject({ side: "out", file: "a.xlsx", row: 5 });
    expect(debit?.change).toMatchObject({
      action: "create",
      object: "Документ.СписаниеСРасчетногоСчета",
      post: false,
      fields: {
        Дата: "2026-09-10",
        СуммаДокумента: 250_000,
        НазначениеПлатежа: "Перевод между своими счетами",
        ВидОперации: "ПереводНаДругойСчетОрганизации",
        БанковскийСчет: { type: "Справочник.БанковскиеСчета", ref: REF_A },
        СчетПолучатель: { type: "Справочник.БанковскиеСчета", ref: REF_B },
      },
    });
    expect(receipt).toMatchObject({ side: "in", file: "b.xlsx", row: 9 });
    expect(receipt?.change).toMatchObject({
      object: "Документ.ПоступлениеНаРасчетныйСчет",
      fields: {
        БанковскийСчет: { ref: REF_B },
        СчетПолучатель: { ref: REF_A },
        СуммаДокумента: 250_000,
      },
    });
    // Nothing of the old document that belongs to it alone is carried over.
    expect(debit?.change.fields).not.toHaveProperty("Номер");
    expect(debit?.change.fields).not.toHaveProperty("Проведен");
    expect(out.notes[0]).toContain("copied from the company's 0000-000003 of 2026-08-01");
  });

  it("enters only the leg whose statement is attached", async () => {
    const out = await run([move({ in: null })], {}, ["a.xlsx"]);
    expect(out.ready.map((r) => r.side)).toEqual(["out"]);
    const other = await run([move()], {}, ["b.xlsx"]);
    expect(other.ready.map((r) => r.side)).toEqual(["in"]);
  });

  it("prefers the earlier document of the same pair of accounts", async () => {
    const same = earlier("Документ.СписаниеСРасчетногоСчета", {
      Номер: "0000-000009",
      БанковскийСчет: account(REF_A),
      СчетПолучатель: account(REF_B),
    });
    const out = await run(
      [move({ in: null })],
      {
        docs: [
          {
            object: "Документ.СписаниеСРасчетногоСчета",
            ref: OUT_DOC,
            kind: "own",
            snapshot: earlier("Документ.СписаниеСРасчетногоСчета"),
          },
          { object: "Документ.СписаниеСРасчетногоСчета", ref: OUT_OTHER, kind: "own", snapshot: same },
        ],
      },
      ["a.xlsx"],
    );
    expect(out.notes[0]).toContain("0000-000009");
  });

  it("leaves out a leg 1C already has: the same account, day and amount", async () => {
    const out = await run([move()], { existing: [[REF_A, "2026-09-10T00:00:00", "out", 250_000]] });
    expect(out.alreadyIn1c).toEqual([{ file: "a.xlsx", row: 5 }]);
    expect(out.ready.map((r) => r.side)).toEqual(["in"]);
  });

  it("does not enter what the accountant already entered in this chat", async () => {
    const out = await run([move()], {}, ["a.xlsx", "b.xlsx"], new Set(["a.xlsx#5"]));
    expect(out.ready.map((r) => r.side)).toEqual(["in"]);
  });

  it("says why when it cannot: no earlier document, an account 1C lacks", async () => {
    const none = await run([move()], { kinds: false });
    expect(none.ready).toEqual([]);
    expect(none.problems[0]?.message).toContain("1C has no posted");
    const missing = await run([move()], { accounts: [[A, REF_A]] });
    expect(missing.problems[0]?.message).toContain(`the other account ${B}`);
    expect(missing.ready).toEqual([]);
  });

  it("refuses a document with no place for the other account", async () => {
    const bare = earlier("Документ.СписаниеСРасчетногоСчета", { СчетПолучатель: undefined });
    const out = await run(
      [move({ in: null })],
      {
        docs: [
          {
            object: "Документ.СписаниеСРасчетногоСчета",
            ref: OUT_DOC,
            kind: "own",
            snapshot: bare,
          },
        ],
      },
      ["a.xlsx"],
    );
    expect(out.problems[0]?.message).toContain("no attribute for the other account");
  });

  describe("a conversion between a soum account and a dollar account", () => {
    // 1C refuses «Перевод на другой счёт» between accounts of two currencies: the company writes the soums off as
    // «Прочее списание» and takes the dollars in as «Перевод с другого счёта», each in its own currency.
    const writeOff = () =>
      earlier("Документ.СписаниеСРасчетногоСчета", {
        ВидОперации: ref(
          "Перечисление.ВидыОперацийСписаниеДенежныхСредств",
          "ПрочееСписание",
          "Прочее списание",
        ),
        СчетПолучатель: undefined,
      });
    const takeIn = () =>
      earlier("Документ.ПоступлениеНаРасчетныйСчет", {
        ВалютаДокумента: ref("Справочник.Валюты", "77777777-7777-4777-8777-777777777777", "сум"),
        КурсДокумента: 1,
      });
    const world = (over: Partial<World> = {}): World => ({
      accounts: [
        [A, REF_A],
        [USD, REF_USD],
      ],
      rate: 12_700.5,
      docs: [
        { object: "Документ.СписаниеСРасчетногоСчета", ref: OUT_DOC, kind: "x", snapshot: writeOff() },
        { object: "Документ.ПоступлениеНаРасчетныйСчет", ref: IN_DOC, kind: "x", snapshot: takeIn() },
      ],
      ...over,
    });
    const buy = move({
      kind: "conversion",
      toAccount: USD,
      amount: 127_005_000,
      out: { file: "a.xlsx", row: 5 },
      in: { file: "c.xlsx", row: 3 },
    });
    const files = [
      statement("a.xlsx", A, [payment({ row: 5, account: USD, amount: 127_005_000 })]),
      statement("c.xlsx", USD, [
        payment({ row: 3, direction: "in", account: A, amount: 10_000, purpose: "Конвертация" }),
      ]),
    ];
    const resolve = (w: World) =>
      resolveTransfers(
        [buy],
        files,
        { ownInn: "300000001", files: new Set(["a.xlsx", "c.xlsx"]) },
        deps(w).d,
      );

    it("is entered as a write-off in soums and a receipt in dollars, each leg in its own currency", async () => {
      const out = await resolve(world());
      expect(out.problems).toEqual([]);
      const [debit, receipt] = out.ready;
      expect(debit).toMatchObject({ side: "out", file: "a.xlsx" });
      expect(debit?.change.fields).toMatchObject({
        СуммаДокумента: 1_270_050,
        ВидОперации: "ПрочееСписание",
        БанковскийСчет: { ref: REF_A },
      });
      expect(receipt).toMatchObject({ side: "in", file: "c.xlsx" });
      expect(receipt?.change.fields).toMatchObject({
        СуммаДокумента: 100,
        БанковскийСчет: { ref: REF_USD },
        СчетПолучатель: { ref: REF_A },
        ВалютаДокумента: { ref: USD_ITEM },
      });
      expect(out.notes.join(" ")).toContain("each leg is its own document in its own currency");
    });

    it("books the dollar leg at the conversion's own rate (soums paid ÷ dollars received), so the two sides close", async () => {
      // 1 285 000 soums paid for 100 dollars: 12 850, not the Central Bank's 12 700.50.
      const files2 = [
        statement("a.xlsx", A, [payment({ row: 5, account: USD, amount: 128_500_000 })]),
        statement("c.xlsx", USD, [
          payment({ row: 3, direction: "in", account: A, amount: 10_000, purpose: "Конвертация" }),
        ]),
      ];
      const out = await resolveTransfers(
        [{ ...buy, amount: 128_500_000 }],
        files2,
        { ownInn: "300000001", files: new Set(["a.xlsx", "c.xlsx"]) },
        deps(world()).d,
      );
      expect(out.problems).toEqual([]);
      const receipt = out.ready.find((r) => r.side === "in");
      expect(receipt?.change.fields).toMatchObject({ КурсДокумента: 12_850, СуммаДокумента: 100 });
      expect(out.notes.join(" ")).toContain("conversion's own rate");
    });

    it("keeps the Central Bank's rate for a leg whose other side is not attached or does not fit", async () => {
      const out = await resolveTransfers(
        [buy],
        files,
        { ownInn: "300000001", files: new Set(["c.xlsx"]) },
        deps(world()).d,
      );
      expect(out.ready[0]?.change.fields).toMatchObject({ КурсДокумента: 12_700.5 });
      expect(out.notes.join(" ")).not.toContain("conversion's own rate");
    });

    it("says what is missing instead of guessing: no write-off to copy, or no rate of the day", async () => {
      const noWriteOff = await resolve(world({ docs: world().docs!.filter((d) => d.ref !== OUT_DOC) }));
      expect(noWriteOff.ready.map((r) => r.side)).toEqual(["in"]);
      expect(noWriteOff.problems[0]?.message).toContain("Прочее списание");
      // No Central Bank rate: a paired leg still has the conversion's own rate; a lone one has none.
      const paired = await resolve(world({ rate: 0 }));
      expect(paired.ready.map((r) => r.side)).toEqual(["out", "in"]);
      const lone = await resolveTransfers(
        [buy],
        files,
        { ownInn: "300000001", files: new Set(["c.xlsx"]) },
        deps(world({ rate: 0 })).d,
      );
      expect(lone.ready).toEqual([]);
      expect(lone.problems[0]?.message).toContain("rate");
    });
  });
});
