import { describe, expect, it } from "vitest";

import { type BankDeps, copyTemplate, resolvePayments } from "./resolve.js";
import type { BankPayment, BankStatement } from "./statement.js";

const OWN = "11111111-1111-4111-8111-111111111111";
const SUPPLIER = "22222222-2222-4222-8222-222222222222";
const CONTRACT_USD = "33333333-3333-4333-8333-333333333333";
const CONTRACT_UZS = "44444444-4444-4444-8444-444444444444";
const DOC_UZS = "55555555-5555-4555-8555-555555555555";
const DOC_USD = "66666666-6666-4666-8666-666666666666";
const USD_ACCOUNT = "22614840500000000001";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });

const payment = (over: Partial<BankPayment> = {}): BankPayment => ({
  row: 4,
  date: "2026-09-10",
  number: "31",
  direction: "out",
  amount: 120_000, // 1 200.00 USD
  counterparty: "ACME TRADING LLC",
  inn: "300555777",
  account: "",
  mfo: "",
  purpose: "Payment for goods under contract 7",
  ...over,
});

/** A payment in dollars: 1 000.00 USD, settled in soums at 12 650. */
const usdDoc = (settled: "usd" | "soums" = "soums") => ({
  fields: {
    Номер: "0000-000021",
    Дата: "2026-08-10T00:00:00",
    Проведен: true,
    ВидОперации: ref(
      "Перечисление.ВидыОперацийСписаниеДенежныхСредств",
      "ОплатаПоставщику",
      "Оплата поставщику",
    ),
    ВалютаДокумента: ref("Справочник.Валюты", "77777777-7777-4777-8777-777777777777", "Доллар США"),
    БанковскийСчет: ref("Справочник.БанковскиеСчета", "88888888-8888-4888-8888-888888888888", "USD"),
    Контрагент: ref("Справочник.Контрагенты", SUPPLIER, "ACME TRADING LLC"),
    ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", CONTRACT_USD, "№7"),
    СуммаДокумента: 1000,
    НазначениеПлатежа: "старое",
  },
  tables: {
    РасшифровкаПлатежа: [
      {
        ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", CONTRACT_USD, "№7"),
        СуммаПлатежа: 1000,
        КурсВзаиморасчетов: 12_650,
        КратностьВзаиморасчетов: 1,
        СуммаВзаиморасчетов: settled === "soums" ? 12_650_000 : 1000,
        СуммаНДС: 0,
      },
    ],
  },
});

const uzsDoc = () => ({
  fields: {
    ...usdDoc().fields,
    Номер: "0000-000030",
    Дата: "2026-09-01T00:00:00",
    ВалютаДокумента: ref("Справочник.Валюты", "99999999-9999-4999-8999-999999999999", "сум"),
    ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", CONTRACT_UZS, "№8"),
    СуммаДокумента: 5_000_000,
  },
  tables: {
    РасшифровкаПлатежа: [
      {
        ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", CONTRACT_UZS, "№8"),
        СуммаПлатежа: 5_000_000,
        КурсВзаиморасчетов: 1,
        КратностьВзаиморасчетов: 1,
        СуммаВзаиморасчетов: 5_000_000,
        СуммаНДС: 0,
      },
    ],
  },
});

describe("a payment on a foreign-currency account, copied from the counterparty's payment in that currency", () => {
  it("scales the amounts and takes the rate of the payment's day; the settlement in soums follows the rate", () => {
    const template = { object: "Документ.СписаниеСРасчетногоСчета", ref: DOC_USD, ...usdDoc() };
    const made = copyTemplate(template, payment(), {
      ownAccount: OWN,
      foreign: { currency: "USD", rate: 12_700.5 },
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.change.fields).toMatchObject({ СуммаДокумента: 1200, Дата: "2026-09-10" });
    expect(made.change.tables?.РасшифровкаПлатежа).toEqual([
      expect.objectContaining({
        СуммаПлатежа: 1200,
        КурсВзаиморасчетов: 12_700.5,
        СуммаВзаиморасчетов: 15_240_600,
      }),
    ]);
    expect(made.notes?.[0]).toContain("USD payment at the rate 12700.5");
  });

  it("settled in dollars: the settlement amount scales with the payment, the rate is the new one", () => {
    const template = { object: "Документ.СписаниеСРасчетногоСчета", ref: DOC_USD, ...usdDoc("usd") };
    const made = copyTemplate(template, payment(), { foreign: { currency: "USD", rate: 12_700 } });
    expect(made.ok && made.change.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      СуммаПлатежа: 1200,
      СуммаВзаиморасчетов: 1200,
      КурсВзаиморасчетов: 12_700,
    });
  });

  it("keeps the earlier rate and says so when 1C has no rate for the day", () => {
    const template = { object: "Документ.СписаниеСРасчетногоСчета", ref: DOC_USD, ...usdDoc() };
    const made = copyTemplate(template, payment(), { foreign: { currency: "USD", rate: null } });
    expect(made.ok && made.change.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      КурсВзаиморасчетов: 12_650,
    });
    expect(made.ok && made.notes?.[0]).toContain("was not found in 1C");
  });

  it("refuses a payment in soums for a dollar account, and a dollar one for a soum account", () => {
    const soums = copyTemplate(
      { object: "Документ.СписаниеСРасчетногоСчета", ref: DOC_UZS, ...uzsDoc() },
      payment(),
      {
        foreign: { currency: "USD", rate: 12_700 },
      },
    );
    expect(soums).toMatchObject({ ok: false, message: expect.stringContaining("must be in USD") });
    const dollars = copyTemplate(
      { object: "Документ.СписаниеСРасчетногоСчета", ref: DOC_USD, ...usdDoc() },
      payment(),
      {},
    );
    expect(dollars).toMatchObject({ ok: false, message: expect.stringContaining("foreign currency") });
  });
});

describe("a soum document whose rate was never filled in", () => {
  it("is a soum payment (rate 0), not a foreign one: it can be copied", () => {
    const doc = uzsDoc();
    const row = doc.tables.РасшифровкаПлатежа[0];
    if (row) row.КурсВзаиморасчетов = 0;
    const made = copyTemplate(
      { object: "Документ.СписаниеСРасчетногоСчета", ref: DOC_UZS, ...doc },
      payment(),
      {
        ownAccount: OWN,
      },
    );
    expect(made.ok).toBe(true);
  });
});

function deps(rates: Record<string, number> = { "840": 12_700.5 }) {
  const seen: string[] = [];
  const docs = [
    { ref: DOC_UZS, snapshot: uzsDoc() }, // the newest, in soums
    { ref: DOC_USD, snapshot: usdDoc() },
  ];
  const d: BankDeps = {
    async query(input) {
      const q = input.query;
      seen.push(q);
      const rows = (list: unknown[][]) => ({ ok: true as const, data: { rows: list } });
      if (q.includes("КурсыВалют")) {
        const rate = rates[String(input.params?.Код)];
        return rows(rate ? [[rate, 1]] : []);
      }
      if (q.includes("Справочник.БанковскиеСчета") && q.includes("НомерСчета В"))
        return rows([[ref("Справочник.БанковскиеСчета", OWN, "USD")]]);
      if (q.includes("Справочник.Контрагенты"))
        return rows([
          ["300555777", ref("Справочник.Контрагенты", SUPPLIER, "ACME TRADING LLC"), "ACME TRADING LLC"],
        ]);
      if (q.includes("ПЕРВЫЕ 20"))
        return rows(docs.map((x) => [ref("Документ.СписаниеСРасчетногоСчета", x.ref, "док"), "старое"]));
      return rows([]);
    },
    async describe() {
      return { ok: true, data: [] };
    },
    async getObject(object, id) {
      const found = docs.find((x) => x.ref === id);
      return found
        ? { ok: true, data: { object, ref: id, ...found.snapshot } }
        : { ok: false, code: "NOT_FOUND", message: "none" };
    },
  };
  return { d, seen };
}

const statement = (payments: BankPayment[]): BankStatement => ({
  fileName: "usd.xlsx",
  sheet: "s",
  account: USD_ACCOUNT,
  payments,
  issues: [],
  columns: {},
  convention: "",
});

describe("a foreign-currency statement", () => {
  it("takes the counterparty's payment in dollars, not its newest one in soums, and the rate from 1C", async () => {
    const { d, seen } = deps();
    const out = await resolvePayments(statement([payment()]), { currency: "USD" }, d);
    expect(out.problems).toEqual([]);
    expect(out.ready).toHaveLength(1);
    expect(out.ready[0]?.change.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      СуммаПлатежа: 1200,
      КурсВзаиморасчетов: 12_700.5,
    });
    expect(out.ready[0]?.change.fields?.ДоговорКонтрагента).toMatchObject({ ref: CONTRACT_USD });
    expect(out.notes.some((n) => n.message.includes("USD payment at the rate 12700.5"))).toBe(true);
    expect(seen.some((q) => q.includes("КурсыВалют"))).toBe(true);
  });

  it("tries the letter code when the catalog keeps no numeric one, and says when it finds no rate", async () => {
    const letters = await resolvePayments(
      statement([payment()]),
      { currency: "USD" },
      deps({ USD: 12_690 }).d,
    );
    expect(letters.ready[0]?.change.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      КурсВзаиморасчетов: 12_690,
    });
    const none = await resolvePayments(statement([payment()]), { currency: "USD" }, deps({}).d);
    expect(none.ready).toHaveLength(1);
    expect(none.notes.some((n) => n.message.includes("was not found in 1C"))).toBe(true);
  });

  it("does not copy a dollar payment for a soum statement: it takes the counterparty's one in soums", async () => {
    const out = await resolvePayments(statement([payment({ amount: 700_000_000 })]), {}, deps().d);
    expect(out.problems).toEqual([]);
    expect(out.ready[0]?.change.fields?.ДоговорКонтрагента).toMatchObject({ ref: CONTRACT_UZS });
  });
});
