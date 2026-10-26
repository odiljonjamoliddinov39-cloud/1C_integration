import type { ChangeInput, RunQueryInput } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { completePayment } from "./complete.js";
import type { BankCache, BankDeps } from "./resolve.js";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
const A4310 = "a4310000-0000-4000-8000-000000000000";
const A6010 = "a6010000-0000-4000-8000-000000000000";
const A6310 = "a6310000-0000-4000-8000-000000000000";
const A4010 = "a4010000-0000-4000-8000-000000000000";
const C6011 = "a6011000-0000-4000-8000-000000000000";

const DOC = "Документ.СписаниеСРасчетногоСчета";
const description = {
  attributes: [
    {
      name: "ВидОперации",
      synonym: "Вид операции",
      types: ["Перечисление.ВидыОперацийСписаниеДенежныхСредств"],
    },
    { name: "СчетУчетаРасчетовСКонтрагентом", synonym: "Счет расчетов", types: ["ПланСчетов.Хозрасчетный"] },
  ],
  tabularSections: [
    {
      name: "РасшифровкаПлатежа",
      synonym: "",
      attributes: [
        { name: "ДоговорКонтрагента", synonym: "Договор", types: ["Справочник.ДоговорыКонтрагентов"] },
        { name: "СуммаПлатежа", synonym: "Сумма", types: [] },
        {
          name: "СпособПогашенияЗадолженности",
          synonym: "Погашение задолженности",
          types: ["Перечисление.СпособыПогашенияЗадолженности"],
        },
        {
          name: "СчетУчетаРасчетовСКонтрагентом",
          synonym: "Счет расчетов",
          types: ["ПланСчетов.Хозрасчетный"],
        },
        { name: "СчетУчетаРасчетовПоАвансам", synonym: "Счет авансов", types: ["ПланСчетов.Хозрасчетный"] },
      ],
    },
  ],
};

function fake(options: { currencyFlag?: boolean } = {}) {
  const seen: RunQueryInput[] = [];
  const deps: BankDeps = {
    async query(input) {
      seen.push(input);
      const q = input.query;
      const rows = (list: unknown[][]) => ({ ok: true as const, data: { rows: list } });
      if (q.includes("СпособыПогашенияЗадолженности"))
        return rows([
          [ref("Перечисление.СпособыПогашенияЗадолженности", "Автоматически", "Автоматически")],
          [ref("Перечисление.СпособыПогашенияЗадолженности", "НеПогашать", "Не погашать")],
        ]);
      if (q.includes("ПОДОБНО")) return rows([["6011", ref("ПланСчетов.Хозрасчетный", C6011, "6011")]]);
      if (q.includes("Т.Валютный КАК Валютный")) {
        const asked = String(input.params?.п0);
        return rows(
          [
            ["6010", ref("ПланСчетов.Хозрасчетный", A6010, "6010"), options.currencyFlag ?? false],
            ["4310", ref("ПланСчетов.Хозрасчетный", A4310, "4310"), true],
          ].filter(([code]) => code === asked),
        );
      }
      if (q.includes("ПланСчетов.Хозрасчетный"))
        return rows([
          ["4310", ref("ПланСчетов.Хозрасчетный", A4310, "4310")],
          ["6010", ref("ПланСчетов.Хозрасчетный", A6010, "6010")],
          ["6310", ref("ПланСчетов.Хозрасчетный", A6310, "6310")],
          ["4010", ref("ПланСчетов.Хозрасчетный", A4010, "4010")],
        ]);
      return rows([]);
    },
    async describe() {
      return { ok: true, data: [description] };
    },
    async getObject() {
      return { ok: false, code: "X", message: "none" };
    },
  };
  const cache: BankCache = { lists: new Map(), snapshots: new Map() };
  return { deps, cache, seen };
}

const change = (kind: string, row: Record<string, unknown> = {}): ChangeInput => ({
  action: "create",
  object: DOC,
  fields: { ВидОперации: kind, СчетУчетаРасчетовСКонтрагентом: null },
  tables: {
    РасшифровкаПлатежа: [
      {
        ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", "c", "№1"),
        СуммаПлатежа: 100,
        СпособПогашенияЗадолженности: null,
        СчетУчетаРасчетовСКонтрагентом: null,
        СчетУчетаРасчетовПоАвансам: null,
        ...row,
      },
    ],
  },
});

describe("what a payment document needs to post", () => {
  it("gets the way the debt is repaid and the account of advances: without them 1C books it to an empty account", async () => {
    const { deps, cache } = fake();
    const doc = change("ОплатаПоставщику");
    const notes = await completePayment(deps, cache, doc, { date: "2024-01-16" });
    expect(doc.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      СпособПогашенияЗадолженности: "Автоматически",
      СчетУчетаРасчетовСКонтрагентом: { type: "ПланСчетов.Хозрасчетный", ref: A6010 },
      СчетУчетаРасчетовПоАвансам: { type: "ПланСчетов.Хозрасчетный", ref: A4310 },
    });
    expect(doc.fields?.["СчетУчетаРасчетовСКонтрагентом"]).toMatchObject({ ref: A6010 });
    expect(notes.join(" ")).toContain("the account of advances 4310");
    expect(notes.join(" ")).toContain("the repayment way «Автоматически»");
  });

  it("a receipt from a buyer settles on 4010 and its advances on 6310", async () => {
    const { deps, cache } = fake();
    const doc = change("ОплатаПокупателя");
    await completePayment(deps, cache, doc, { date: "2024-01-16" });
    expect(doc.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      СчетУчетаРасчетовСКонтрагентом: { ref: A4010 },
      СчетУчетаРасчетовПоАвансам: { ref: A6310 },
    });
  });

  it("leaves what a copied posted payment already has, and does nothing for a document that is not a payment", async () => {
    const { deps, cache } = fake();
    const mine = ref("ПланСчетов.Хозрасчетный", "keep", "4310.5");
    const doc = change("ОплатаПоставщику", {
      СпособПогашенияЗадолженности: "НеПогашать",
      СчетУчетаРасчетовПоАвансам: mine,
      СчетУчетаРасчетовСКонтрагентом: ref("ПланСчетов.Хозрасчетный", "own6", "6010.2"),
    });
    await completePayment(deps, cache, doc, { date: "2024-01-16" });
    expect(doc.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      СпособПогашенияЗадолженности: "НеПогашать",
      СчетУчетаРасчетовПоАвансам: { ref: "keep" },
      СчетУчетаРасчетовСКонтрагентом: { ref: "own6" },
    });
    const other = change("УплатаНалога");
    expect(await completePayment(deps, cache, other, { date: "2024-01-16" })).toEqual([]);
    expect(other.tables?.РасшифровкаПлатежа?.[0]?.["СчетУчетаРасчетовПоАвансам"]).toBeNull();
  });

  it("uses an account that can hold a currency for a contract in a currency, or says there is none", async () => {
    const { deps, cache } = fake({ currencyFlag: false });
    const doc = change("ОплатаПоставщику");
    await completePayment(deps, cache, doc, { date: "2024-01-16", contractCurrency: "USD" });
    // 6010 is not a currency account in this chart: 6011 is the only one of its group
    expect(doc.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      СчетУчетаРасчетовСКонтрагентом: { ref: C6011 },
      СчетУчетаРасчетовПоАвансам: { ref: A4310 },
    });
  });
  it("replaces the soum accounts a payment in soums brought to a contract in a currency, keeps a currency one", async () => {
    const { deps, cache } = fake({ currencyFlag: false });
    const plain6010 = ref("ПланСчетов.Хозрасчетный", A6010, "6010");
    const doc = change("ОплатаПоставщику", {
      СчетУчетаРасчетовСКонтрагентом: plain6010,
      СчетУчетаРасчетовПоАвансам: ref("ПланСчетов.Хозрасчетный", A4310, "4310"),
    });
    if (doc.fields) doc.fields["СчетУчетаРасчетовСКонтрагентом"] = plain6010;
    await completePayment(deps, cache, doc, { date: "2024-01-16", contractCurrency: "USD" });
    expect(doc.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      СчетУчетаРасчетовСКонтрагентом: { ref: C6011 },
      СчетУчетаРасчетовПоАвансам: { ref: A4310 },
    });
    expect(doc.fields?.["СчетУчетаРасчетовСКонтрагентом"]).toMatchObject({ ref: C6011 });
    // in soums nothing is replaced
    const other = fake({ currencyFlag: false });
    const soum = change("ОплатаПоставщику", { СчетУчетаРасчетовСКонтрагентом: plain6010 });
    await completePayment(other.deps, other.cache, soum, { date: "2024-01-16", contractCurrency: "UZS" });
    expect(soum.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      СчетУчетаРасчетовСКонтрагентом: { ref: A6010 },
    });
  });
});
