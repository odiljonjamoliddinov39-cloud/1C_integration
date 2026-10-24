import type { RunQueryInput } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { buildBankDocument } from "./build.js";
import type { BankCache, BankDeps } from "./resolve.js";
import type { BankPayment } from "./statement.js";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
const OWN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const SOUM = "44444444-4444-4444-8444-444444444444";
const USD = "55555555-5555-4555-8555-555555555555";
const BANK = "66666666-6666-4666-8666-666666666666";
const CONTRACT = "77777777-7777-4777-8777-777777777777";
const A5710 = "a5710000-0000-4000-8000-000000000000";
const A5730 = "a5730000-0000-4000-8000-000000000000";
const A5740 = "a5740000-0000-4000-8000-000000000000";
const A9430 = "a9430000-0000-4000-8000-000000000000";

const enumValue = (type: string, name: string, shown: string) => ref(`Перечисление.${type}`, name, shown);

const attrs = (names: Record<string, string[]>) =>
  Object.entries(names).map(([name, types]) => ({ name, synonym: "", types }));

/** The two bank documents of the Uzbek configuration: the company's account is «СчетОрганизации». */
const DESCRIPTIONS: Record<string, unknown> = {
  "Документ.СписаниеСРасчетногоСчета": {
    fullName: "Документ.СписаниеСРасчетногоСчета",
    attributes: attrs({
      Организация: ["Справочник.Организации"],
      ВидОперации: ["Перечисление.ВидыОперацийСписаниеДенежныхСредств"],
      СчетОрганизации: ["Справочник.БанковскиеСчета"],
      СчетПолучатель: ["Справочник.БанковскиеСчета"],
      Контрагент: ["Справочник.Контрагенты"],
      ДоговорКонтрагента: ["Справочник.ДоговорыКонтрагентов"],
      СчетУчетаРасчетовСКонтрагентом: ["ПланСчетов.Хозрасчетный"],
      ВалютаДокумента: ["Справочник.Валюты"],
      КурсДокумента: [],
      КратностьДокумента: [],
      СуммаДокумента: [],
      НазначениеПлатежа: [],
      НомерВходящегоДокумента: [],
      ДатаВходящегоДокумента: [],
      Комментарий: [],
    }),
    tabularSections: [],
  },
  "Документ.ПоступлениеНаРасчетныйСчет": {
    fullName: "Документ.ПоступлениеНаРасчетныйСчет",
    attributes: attrs({
      Организация: ["Справочник.Организации"],
      ВидОперации: ["Перечисление.ВидыОперацийПоступлениеДенежныхСредств"],
      СчетОрганизации: ["Справочник.БанковскиеСчета"],
      СчетОтправитель: ["Справочник.БанковскиеСчета"],
      Контрагент: ["Справочник.Контрагенты"],
      ДоговорКонтрагента: ["Справочник.ДоговорыКонтрагентов"],
      СчетУчетаРасчетовСКонтрагентом: ["ПланСчетов.Хозрасчетный"],
      ВалютаДокумента: ["Справочник.Валюты"],
      КурсДокумента: [],
      КратностьДокумента: [],
      СуммаДокумента: [],
      НазначениеПлатежа: [],
      Комментарий: [],
    }),
    tabularSections: [],
  },
};

const fake = (options: { chart?: string[]; operations?: boolean } = {}) => {
  const seen: RunQueryInput[] = [];
  const chart = new Set(options.chart ?? ["5710", "5730", "5740", "9420", "9430"]);
  const accounts: Record<string, string> = {
    "5710": A5710,
    "5730": A5730,
    "5740": A5740,
    "9420": A9430,
    "9430": A9430,
  };
  const deps: BankDeps = {
    query: async (input) => {
      seen.push(input);
      const q = input.query;
      const rows = (list: unknown[][]) => ({ ok: true as const, data: { rows: list } });
      if (q.includes("Перечисление.ВидыОперацийСписаниеДенежныхСредств"))
        return rows([
          [enumValue("ВидыОперацийСписаниеДенежныхСредств", "ОплатаПоставщику", "Оплата поставщику")],
          [
            enumValue(
              "ВидыОперацийСписаниеДенежныхСредств",
              "ПереводНаДругойСчет",
              "Перевод на другой счет организации",
            ),
          ],
          [enumValue("ВидыОперацийСписаниеДенежныхСредств", "ПрочееСписание", "Прочее списание")],
        ]);
      if (q.includes("Перечисление.ВидыОперацийПоступлениеДенежныхСредств"))
        return rows([
          [enumValue("ВидыОперацийПоступлениеДенежныхСредств", "ОплатаПокупателя", "Оплата покупателя")],
          [
            enumValue(
              "ВидыОперацийПоступлениеДенежныхСредств",
              "ПереводСДругогоСчета",
              "Перевод с другого счета организации",
            ),
          ],
          [enumValue("ВидыОперацийПоступлениеДенежныхСредств", "ПрочееПоступление", "Прочее поступление")],
        ]);
      if (q.includes("ПланСчетов.Хозрасчетный")) {
        const found = Object.entries(accounts).filter(([code]) => chart.has(code) && q.includes("Код В"));
        return rows(found.map(([code, id]) => [code, ref("ПланСчетов.Хозрасчетный", id, code)]));
      }
      if (q.includes("Справочник.Валюты")) return rows([[ref("Справочник.Валюты", SOUM, "сўм")]]);
      return rows([]);
    },
    describe: async (objects) => ({ ok: true, data: objects.map((o) => DESCRIPTIONS[o]).filter(Boolean) }),
    getObject: async () => ({ ok: false, code: "X", message: "none" }),
  };
  const cache: BankCache = { lists: new Map(), snapshots: new Map() };
  return { deps, cache, seen };
};

const payment = (over: Partial<BankPayment> = {}): BankPayment => ({
  row: 7,
  date: "2024-01-16",
  number: "000004-ОПК",
  direction: "out",
  amount: 500_000,
  counterparty: "Bank fee",
  inn: "",
  account: "",
  mfo: "",
  purpose: "За Комиссия за iBank-24 5000.00",
  ...over,
});

describe("a bank fee made from 1C's description of the document", () => {
  it("is «Прочее списание» on the company's account, to the expense account, with the bank's own words", async () => {
    const { deps, cache } = fake();
    const out = await buildBankDocument(deps, cache, {
      kind: "fee",
      payment: payment(),
      organization: ORG,
      ownAccount: OWN,
      currency: "UZS",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.change).toMatchObject({
      action: "create",
      object: "Документ.СписаниеСРасчетногоСчета",
      post: false,
      fields: {
        Дата: "2024-01-16",
        ВидОперации: "ПрочееСписание",
        // the Uzbek configuration's name for the company's account, not «БанковскийСчет»
        СчетОрганизации: { type: "Справочник.БанковскиеСчета", ref: OWN },
        СуммаДокумента: 5000,
        НазначениеПлатежа: "За Комиссия за iBank-24 5000.00",
        НомерВходящегоДокумента: "000004-ОПК",
        Организация: { type: "Справочник.Организации", ref: ORG },
        СчетУчетаРасчетовСКонтрагентом: { type: "ПланСчетов.Хозрасчетный", ref: A9430 },
        ВалютаДокумента: { type: "Справочник.Валюты", ref: SOUM },
      },
    });
    expect(JSON.stringify(out.change)).not.toContain("БанковскийСчет");
  });

  it("says what it cannot do: no such operation, an account the chart lacks, no place for the company's account", async () => {
    const { deps, cache } = fake({ chart: [] });
    const noAccount = await buildBankDocument(deps, cache, {
      kind: "fee",
      payment: payment(),
      organization: ORG,
      ownAccount: OWN,
      currency: "UZS",
    });
    expect(noAccount.ok).toBe(true);
    if (noAccount.ok) expect(noAccount.notes.join(" ")).toContain("is not in the company's chart");
    const blind: BankDeps = { ...deps, describe: async () => ({ ok: true, data: [] }) };
    const out = await buildBankDocument(
      blind,
      { lists: new Map(), snapshots: new Map() },
      {
        kind: "fee",
        payment: payment(),
        organization: ORG,
        ownAccount: OWN,
        currency: "UZS",
      },
    );
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.message).toContain("cannot be made from 1C's own description");
  });
});

describe("a transfer between the company's own accounts", () => {
  it("is a pair: «Перевод на другой счёт» out and «Перевод с другого счёта» in, each naming the other account, through the transit account", async () => {
    const { deps, cache } = fake();
    const out = await buildBankDocument(deps, cache, {
      kind: "transferOut",
      payment: payment({ amount: 12_446_000_000, purpose: "Блокировка средств" }),
      organization: ORG,
      ownAccount: OWN,
      otherAccount: OTHER,
      currency: "UZS",
    });
    const into = await buildBankDocument(deps, cache, {
      kind: "transferIn",
      payment: payment({ direction: "in", amount: 12_446_000_000, purpose: "Блокировка средств" }),
      organization: ORG,
      ownAccount: OTHER,
      otherAccount: OWN,
      currency: "UZS",
    });
    expect(out.ok && into.ok).toBe(true);
    if (!out.ok || !into.ok) return;
    expect(out.change.object).toBe("Документ.СписаниеСРасчетногоСчета");
    expect(out.change.fields).toMatchObject({
      ВидОперации: "ПереводНаДругойСчет",
      СчетОрганизации: { ref: OWN },
      СчетПолучатель: { ref: OTHER },
      СчетУчетаРасчетовСКонтрагентом: { ref: A5710 },
      СуммаДокумента: 124_460_000,
    });
    expect(into.change.object).toBe("Документ.ПоступлениеНаРасчетныйСчет");
    expect(into.change.fields).toMatchObject({
      ВидОперации: "ПереводСДругогоСчета",
      СчетОрганизации: { ref: OTHER },
      СчетОтправитель: { ref: OWN },
    });
  });

  it("is refused when the other account is not known", async () => {
    const { deps, cache } = fake();
    const out = await buildBankDocument(deps, cache, {
      kind: "transferOut",
      payment: payment(),
      organization: ORG,
      ownAccount: OWN,
      currency: "UZS",
    });
    expect(out.ok).toBe(false);
  });
});

describe("the two legs of a currency conversion, as the design has them", () => {
  const conversion = (direction: "buy" | "sell", leg: "out" | "in") => ({
    id: "FX-2024-01-25-USD-4165-1",
    direction,
    leg,
    bank: { counterparty: BANK, contract: CONTRACT },
  });

  it("a purchase: the soums go out to the purchase conversion account, 5730, with the bank and its contract; the dollars come in from it at the day's rate", async () => {
    const { deps, cache } = fake();
    const paying = await buildBankDocument(deps, cache, {
      kind: "conversionOut",
      payment: payment({
        date: "2024-01-25",
        amount: 5_199_586_000,
        purpose: "Конвертация валютных средств 4165.0 'Доллар США' по курсу 12484.0",
      }),
      organization: ORG,
      ownAccount: OWN,
      currency: "UZS",
      conversion: conversion("buy", "out"),
    });
    const taking = await buildBankDocument(deps, cache, {
      kind: "conversionIn",
      payment: payment({
        direction: "in",
        date: "2024-01-25",
        amount: 416_500,
        purpose: "Конвертация валютных средств 4165.0 'Доллар США' по курсу 12484.0",
      }),
      organization: ORG,
      ownAccount: OTHER,
      currency: "USD",
      currencyRef: USD,
      rate: 12_421.76,
      conversion: conversion("buy", "in"),
    });
    expect(paying.ok && taking.ok).toBe(true);
    if (!paying.ok || !taking.ok) return;
    expect(paying.change.fields).toMatchObject({
      Дата: "2024-01-25T10:00:00",
      ВидОперации: "ПрочееСписание",
      СчетУчетаРасчетовСКонтрагентом: { ref: A5730 },
      Контрагент: { type: "Справочник.Контрагенты", ref: BANK },
      ДоговорКонтрагента: { type: "Справочник.ДоговорыКонтрагентов", ref: CONTRACT },
      Комментарий: "Conversion FX-2024-01-25-USD-4165-1",
      СуммаДокумента: 51_995_860,
    });
    // the receiving leg a second later, in dollars at the official rate
    expect(taking.change.fields).toMatchObject({
      Дата: "2024-01-25T10:00:01",
      ВидОперации: "ПрочееПоступление",
      СчетУчетаРасчетовСКонтрагентом: { ref: A5730 },
      ВалютаДокумента: { ref: USD },
      КурсДокумента: 12_421.76,
      КратностьДокумента: 1,
      СуммаДокумента: 4165,
      Комментарий: "Conversion FX-2024-01-25-USD-4165-1",
    });
  });

  it("a sale goes through the other conversion account, 5740", async () => {
    const { deps, cache } = fake();
    const out = await buildBankDocument(deps, cache, {
      kind: "conversionOut",
      payment: payment({ amount: 608_000 }),
      organization: ORG,
      ownAccount: OTHER,
      currency: "USD",
      currencyRef: USD,
      rate: 12_596,
      conversion: conversion("sell", "out"),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.change.fields).toMatchObject({ СчетУчетаРасчетовСКонтрагентом: { ref: A5740 } });
  });

  it("stops when the chart has no conversion account: it is never booked anywhere else", async () => {
    const { deps, cache } = fake({ chart: ["5710", "9430"] });
    const out = await buildBankDocument(deps, cache, {
      kind: "conversionOut",
      payment: payment(),
      organization: ORG,
      ownAccount: OWN,
      currency: "UZS",
      conversion: conversion("buy", "out"),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("no conversion account 5730");
  });

  it("stops when a leg in a currency has no rate, or the currency is not in 1C's catalog", async () => {
    const { deps, cache } = fake();
    const noRate = await buildBankDocument(deps, cache, {
      kind: "conversionIn",
      payment: payment({ direction: "in" }),
      organization: ORG,
      ownAccount: OTHER,
      currency: "USD",
      currencyRef: USD,
      rate: null,
      conversion: conversion("buy", "in"),
    });
    expect(noRate.ok).toBe(false);
    if (!noRate.ok) expect(noRate.message).toContain("exchange rate of USD");
    const noItem = await buildBankDocument(deps, cache, {
      kind: "conversionIn",
      payment: payment({ direction: "in" }),
      organization: ORG,
      ownAccount: OTHER,
      currency: "USD",
      currencyRef: null,
      rate: 12_000,
      conversion: conversion("buy", "in"),
    });
    expect(noItem.ok).toBe(false);
    if (!noItem.ok) expect(noItem.message).toContain("no currency USD");
  });
});
