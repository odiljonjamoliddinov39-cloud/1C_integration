import type { RunQueryInput } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { cashOrderFor } from "./cash.js";
import { buildBankDocument } from "./build.js";
import { type BankCache, type BankDeps, resolvePayments } from "./resolve.js";
import type { BankPayment, BankStatement } from "./statement.js";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
const value = (type: string, name: string, shown: string) => ref(`Перечисление.${type}`, name, shown);
const attrs = (names: Record<string, string[]>) =>
  Object.entries(names).map(([name, types]) => ({ name, synonym: "", types }));

const OWN = "11111111-1111-4111-8111-111111111111";
const ORG = "33333333-3333-4333-8333-333333333333";
const SOUM = "44444444-4444-4444-8444-444444444444";
const FOUNDER = "55555555-5555-4555-8555-555555555555";
const DESK = "66666666-6666-4666-8666-666666666666";
const ACCOUNTS: Record<string, string> = {
  "5710": "a5710000-0000-4000-8000-000000000000",
  "5010": "a5010000-0000-4000-8000-000000000000",
  "4610": "a4610000-0000-4000-8000-000000000000",
};

const bankDoc = (operations: string) => ({
  attributes: attrs({
    Организация: ["Справочник.Организации"],
    ВидОперации: [`Перечисление.${operations}`],
    СчетОрганизации: ["Справочник.БанковскиеСчета"],
    Контрагент: ["Справочник.Контрагенты"],
    СчетУчетаРасчетовСКонтрагентом: ["ПланСчетов.Хозрасчетный"],
    ВалютаДокумента: ["Справочник.Валюты"],
    СуммаДокумента: [],
    НазначениеПлатежа: [],
    НомерВходящегоДокумента: [],
    ДатаВходящегоДокумента: [],
  }),
  tabularSections: [],
});
const DESCRIBE: Record<string, unknown> = {
  "Документ.ПоступлениеНаРасчетныйСчет": bankDoc("ВидыОперацийПоступлениеДенежныхСредств"),
  "Документ.СписаниеСРасчетногоСчета": bankDoc("ВидыОперацийСписаниеДенежныхСредств"),
  "Документ.РасходныйКассовыйОрдер": {
    attributes: attrs({
      Организация: ["Справочник.Организации"],
      ВидОперации: ["Перечисление.ВидыОперацийРКО"],
      Касса: ["Справочник.Кассы"],
      БанковскийСчет: ["Справочник.БанковскиеСчета"],
      СчетУчета: ["ПланСчетов.Хозрасчетный"],
      СуммаДокумента: [],
      Основание: [],
    }),
    tabularSections: [],
  },
};

interface World {
  chart?: string[];
  /** A cash order the cashier already entered. */
  order?: boolean;
  desks?: number;
  orderReadable?: boolean;
}

function deps(world: World = {}): BankDeps {
  const chart = world.chart ?? ["5710", "5010", "4610"];
  return {
    async query(input: RunQueryInput) {
      const q = input.query;
      const rows = (list: unknown[][]) => ({ ok: true as const, data: { rows: list } });
      if (q.includes("Документ.РасходныйКассовыйОрдер"))
        return world.orderReadable === false
          ? { ok: false as const, code: "X", message: "no such object" }
          : rows(world.order ? [[ref("Документ.РасходныйКассовыйОрдер", "r1", "РКО")]] : []);
      if (q.includes("Справочник.Кассы"))
        return rows(
          Array.from({ length: world.desks ?? 1 }, (_, i) => [
            ref("Справочник.Кассы", `${DESK.slice(0, -1)}${i}`, `Касса ${i + 1}`),
            `Касса ${i + 1}`,
          ]),
        );
      if (q.includes("Перечисление.ВидыОперацийРКО"))
        return rows([[value("ВидыОперацийРКО", "СдачаНаличныхВБанк", "Сдача наличных в банк")]]);
      if (q.includes("Перечисление.ВидыОперацийПоступлениеДенежныхСредств"))
        return rows([
          [value("ВидыОперацийПоступлениеДенежныхСредств", "ПрочееПоступление", "Прочее поступление")],
          [value("ВидыОперацийПоступлениеДенежныхСредств", "ВзносНаличными", "Взнос наличными")],
          [value("ВидыОперацийПоступлениеДенежныхСредств", "ВзносУчредителя", "Взнос учредителя")],
        ]);
      if (q.includes("Справочник.БанковскиеСчета"))
        return rows([[ref("Справочник.БанковскиеСчета", OWN, "р/с"), "р/с"]]);
      if (q.includes("ПланСчетов.Хозрасчетный"))
        return rows(
          Object.entries(ACCOUNTS)
            .filter(([code]) => chart.includes(code))
            .map(([code, id]) => [code, ref("ПланСчетов.Хозрасчетный", id, code)]),
        );
      if (q.includes("Справочник.Валюты")) return rows([[ref("Справочник.Валюты", SOUM, "сўм")]]);
      return rows([]);
    },
    describe: async (objects) => ({ ok: true, data: objects.map((o) => DESCRIBE[o]).filter(Boolean) }),
    getObject: async () => ({ ok: false, code: "X", message: "none" }),
  };
}

const cache = (): BankCache => ({ lists: new Map(), snapshots: new Map() });

const payment = (over: Partial<BankPayment> = {}): BankPayment => ({
  row: 3,
  date: "2024-05-20",
  number: "77",
  direction: "in",
  amount: 25_000_000_00,
  counterparty: "TEXMASH IMPORT MCHJ",
  inn: "311012912",
  account: "20208000705733821001",
  mfo: "00444",
  purpose: "Взнос наличными на расчетный счет",
  ...over,
});

describe("the cash side of cash paid into the bank", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    direction: "toBank" as const,
    payment: payment(),
    organization: ORG,
    ownAccount: OWN,
    ...over,
  });

  it("finds the cash order the cashier already entered, and makes none", async () => {
    const out = await cashOrderFor(deps({ order: true }), cache(), input());
    expect(out.status).toBe("found");
  });

  it("makes the cash order from 1C's description when the company has not entered it", async () => {
    const out = await cashOrderFor(deps(), cache(), input());
    expect(out.status).toBe("made");
    if (out.status !== "made") return;
    expect(out.change).toMatchObject({
      action: "create",
      object: "Документ.РасходныйКассовыйОрдер",
      post: false,
    });
    expect(out.change.fields).toMatchObject({
      Дата: "2024-05-20",
      ВидОперации: "СдачаНаличныхВБанк",
      СуммаДокумента: 25_000_000,
      Касса: { ref: expect.stringContaining("66666666") },
      БанковскийСчет: { ref: OWN },
      СчетУчета: { ref: ACCOUNTS["5010"] },
    });
  });

  it("says what is missing instead of choosing: several cash desks, no account, an unreadable object", async () => {
    const many = await cashOrderFor(deps({ desks: 2 }), cache(), input());
    expect(many).toMatchObject({ status: "missing" });
    expect(many.note).toContain("several cash desks");
    const noAccount = await cashOrderFor(deps({ chart: ["5710"] }), cache(), input());
    expect(noAccount.note).toContain("no account 5010");
    const unreadable = await cashOrderFor(deps({ orderReadable: false }), cache(), input());
    expect(unreadable.status).toBe("missing");
  });
});

describe("cash paid in and a founder's contribution as documents", () => {
  it("builds the bank receipt «Взнос наличными» on the transit account 5710", async () => {
    const out = await buildBankDocument(deps(), cache(), {
      kind: "cashIn",
      payment: payment(),
      organization: ORG,
      ownAccount: OWN,
      currency: "UZS",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.change.fields).toMatchObject({
      ВидОперации: "ВзносНаличными",
      СчетОрганизации: { ref: OWN },
      СчетУчетаРасчетовСКонтрагентом: { ref: ACCOUNTS["5710"] },
      СуммаДокумента: 25_000_000,
    });
  });

  it("builds the founder's contribution on 4610 with the founder as the counterparty, and refuses without the account", async () => {
    const spec = {
      kind: "capital" as const,
      payment: payment({ purpose: "Взнос учредителя в уставный капитал" }),
      organization: ORG,
      ownAccount: OWN,
      currency: "UZS",
      counterparty: FOUNDER,
    };
    const out = await buildBankDocument(deps(), cache(), spec);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.change.fields).toMatchObject({
      ВидОперации: "ВзносУчредителя",
      Контрагент: { ref: FOUNDER },
      СчетУчетаРасчетовСКонтрагентом: { ref: ACCOUNTS["4610"] },
    });
    const noChart = await buildBankDocument(deps({ chart: ["5710"] }), cache(), spec);
    expect(noChart.ok).toBe(false);
    if (!noChart.ok) expect(noChart.message).toContain("no account 4610");
  });
});

describe("cash and capital lines of a statement", () => {
  const statement = (payments: BankPayment[]): BankStatement =>
    ({
      fileName: "main.xlsx",
      sheet: "s",
      account: "20208000705733821001",
      payments,
      issues: [],
      columns: {},
      convention: "",
    }) as unknown as BankStatement;

  it("writes cash paid in as the bank receipt and the cash order, with no counterparty looked up", async () => {
    const out = await resolvePayments(
      statement([payment()]),
      {
        companyInn: "311012912",
        cache: cache(),
        organization: ORG,
        kinds: new Map([[3, { type: "cash_deposit" }]]),
      },
      deps(),
    );
    expect(out.problems).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.ready.map((r) => [r.change.object, r.part])).toEqual([
      ["Документ.ПоступлениеНаРасчетныйСчет", undefined],
      ["Документ.РасходныйКассовыйОрдер", "cash_order"],
    ]);
    expect(out.notes.map((n) => n.message).join(" ")).toContain("5710");
  });
});
