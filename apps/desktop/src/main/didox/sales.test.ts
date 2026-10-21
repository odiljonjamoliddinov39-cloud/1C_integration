import { describe, expect, it } from "vitest";

import type { BankDeps } from "../bank/resolve.js";
import { parseDidoxDocument } from "./document.js";
import { resolveSales } from "./sales.js";

const OWN_INN = "300000001";
const BUYER_INN = "201607534";
const BUYER = "11111111-1111-4111-8111-111111111111";
const CONTRACT = "22222222-2222-4222-8222-222222222222";
const ITEM_SOAP = "33333333-3333-4333-8333-333333333333";
const ITEM_RENT = "44444444-4444-4444-8444-444444444444";
const SALE_OLD = "55555555-5555-4555-8555-555555555555";
const SALE_SERVICES = "66666666-6666-4666-8666-666666666666";
const UNIT_PCS = "77777777-7777-4777-8777-777777777777";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });

const line = (name: string, over: Record<string, unknown> = {}) => ({
  ordno: 1,
  name,
  catalogcode: "10403003014000001",
  packagename: "шт",
  count: "10",
  summa: "1000",
  deliverysum: "10000",
  vatrate: 12,
  vatsum: "1200",
  deliverysumwithvat: "11200",
  ...over,
});

function invoice(products: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return parseDidoxDocument({
    facturaid: "abc",
    facturadoc: { facturano: "24", facturadate: "2026-09-10" },
    facturatype: 0,
    sellertin: OWN_INN,
    seller: { name: "CRYSTAL" },
    buyertin: BUYER_INN,
    buyer: { name: "NAVRO'Z-PTK" },
    contractdoc: { contractno: "17", contractdate: "2025-08-08" },
    productlist: { hasvat: true, products },
    ...over,
  })!;
}

/** The company's earlier sale: goods lines with the company's accounts, and (in another one) a service line. */
const earlierSale = (kind: "goods" | "services", over: Record<string, unknown> = {}) => ({
  fields: {
    Номер: "РТ-000007",
    Дата: "2026-08-01T00:00:00",
    Проведен: true,
    ВидОперации: ref("Перечисление.ВидыОперацийРеализация", "Товары", "Товары"),
    Организация: ref("Справочник.Организации", "99999999-9999-4999-8999-999999999999", "CRYSTAL"),
    Контрагент: ref("Справочник.Контрагенты", "00000000-0000-4000-8000-000000000001", "старый"),
    ДоговорКонтрагента: ref(
      "Справочник.ДоговорыКонтрагентов",
      "00000000-0000-4000-8000-000000000002",
      "старый",
    ),
    Склад: ref("Справочник.Склады", "88888888-8888-4888-8888-888888888888", "Основной"),
    СуммаВключаетНДС: false,
    СуммаДокумента: 5600,
    Комментарий: "старый",
    ДокументОснование: ref("Документ.Заказ", "00000000-0000-4000-8000-000000000003", "заказ"),
    ...over,
  },
  tables:
    kind === "goods"
      ? {
          Товары: [
            {
              Номенклатура: ref(
                "Справочник.Номенклатура",
                "00000000-0000-4000-8000-000000000004",
                "старый товар",
              ),
              Количество: 5,
              Цена: 1000,
              Сумма: 5000,
              СтавкаНДС: ref("Перечисление.СтавкиНДС", "НДС12", "12%"),
              СуммаНДС: 600,
              Всего: 5600,
              СчетУчета: ref("ПланСчетов.Хозрасчетный", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2910"),
              СчетДоходов: ref("ПланСчетов.Хозрасчетный", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "9010"),
            },
          ],
          Услуги: [],
        }
      : {
          Товары: [],
          Услуги: [
            {
              Номенклатура: ref(
                "Справочник.Номенклатура",
                "00000000-0000-4000-8000-000000000005",
                "старая услуга",
              ),
              Количество: 1,
              Цена: 5000,
              Сумма: 5000,
              СтавкаНДС: ref("Перечисление.СтавкиНДС", "НДС12", "12%"),
              СуммаНДС: 600,
              Всего: 5600,
              СчетДоходов: ref("ПланСчетов.Хозрасчетный", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "9030"),
            },
          ],
        },
});

interface World {
  buyers?: boolean;
  contracts?: [string, string, string][];
  vat?: string[];
  items?: [string, string][];
  existing?: [string, string, number][];
  sales?: { ref: string; kind: "goods" | "services"; buyer?: boolean; over?: Record<string, unknown> }[];
}

function deps(world: World = {}): BankDeps {
  const sales = world.sales ?? [{ ref: SALE_OLD, kind: "goods" as const, buyer: true }];
  const rows = (list: unknown[][]) => ({ ok: true as const, data: { rows: list } });
  const vat = world.vat ?? ["Без НДС", "12%"];
  return {
    async query(input) {
      const q = input.query;
      const params = Object.values(input.params ?? {});
      if (q.includes("Справочник.Контрагенты КАК Т ГДЕ Т.ИНН В"))
        return rows(
          world.buyers === false
            ? []
            : params.includes(BUYER_INN)
              ? [[BUYER_INN, ref("Справочник.Контрагенты", BUYER, "NAVRO'Z-PTK"), "NAVRO'Z-PTK"]]
              : [],
        );
      if (q.includes("ДоговорыКонтрагентов"))
        return rows(
          (world.contracts ?? [[CONTRACT, "17", "2025-08-08T00:00:00"]]).map(([id, number, date]) => [
            BUYER_INN,
            ref("Справочник.ДоговорыКонтрагентов", id, `№${number}`),
            number,
            date,
          ]),
        );
      if (q.includes("ПРЕДСТАВЛЕНИЕ(Т.Ссылка)")) return rows(vat.map((v) => [v]));
      if (q.includes("Перечисление.СтавкиНДС"))
        return rows(vat.map((v) => [ref("Перечисление.СтавкиНДС", `НДС${v.replace(/\D/g, "") || "0"}`, v)]));
      if (q.includes("Т.ЕдиницаИзмерения КАК Единица"))
        return rows(
          (
            world.items ?? [
              ["Жидкое мыло", ITEM_SOAP],
              ["Аренда офиса", ITEM_RENT],
            ]
          )
            .filter(([name]) => params.includes(name))
            .map(([, id]) => [
              ref("Справочник.Номенклатура", id, "x"),
              ref("Справочник.ЕдиницыИзмерения", UNIT_PCS, "шт"),
            ]),
        );
      if (q.includes("Справочник.Номенклатура КАК Т ГДЕ Т.Наименование В"))
        return rows(
          (
            world.items ?? [
              ["Жидкое мыло", ITEM_SOAP],
              ["Аренда офиса", ITEM_RENT],
            ]
          )
            .filter(([name]) => params.includes(name))
            .map(([name, id]) => [name, ref("Справочник.Номенклатура", id, name)]),
        );
      if (q.includes("РеализацияТоваровУслуг") && q.includes("Т.Дата МЕЖДУ"))
        return rows((world.existing ?? []).map(([inn, date, sum]) => [inn, date, sum]));
      if (q.includes("РеализацияТоваровУслуг") && q.includes("ПЕРВЫЕ 10")) {
        const byBuyer = q.includes("Контрагент.ИНН = &инн");
        return rows(
          sales
            .filter((s) => !byBuyer || s.buyer)
            .map((s) => [ref("Документ.РеализацияТоваровУслуг", s.ref, "продажа")]),
        );
      }
      return rows([]);
    },
    async describe() {
      return { ok: true, data: [] };
    },
    async getObject(object, id) {
      const found = sales.find((s) => s.ref === id);
      return found
        ? { ok: true, data: { object, ref: id, ...earlierSale(found.kind, found.over) } }
        : { ok: false, code: "NOT_FOUND", message: "no such document" };
    },
  };
}

const run = (docs: ReturnType<typeof invoice>[], world: World = {}, extra: Record<string, unknown> = {}) =>
  resolveSales(docs, { companyInn: OWN_INN, ...extra }, deps(world));

describe("sales from the company's own Didox documents", () => {
  it("copies the company's last sale: its accounts and warehouse stay, the buyer, contract, lines and sums change", async () => {
    const out = await run([invoice([line("Жидкое мыло")])]);
    expect(out.problems).toEqual([]);
    expect(out.ready).toHaveLength(1);
    const { change, note } = out.ready[0]!;
    expect(change).toMatchObject({
      action: "create",
      object: "Документ.РеализацияТоваровУслуг",
      post: false,
      fields: {
        Дата: "2026-09-10",
        Контрагент: { type: "Справочник.Контрагенты", ref: BUYER },
        ДоговорКонтрагента: { type: "Справочник.ДоговорыКонтрагентов", ref: CONTRACT },
        Склад: { ref: "88888888-8888-4888-8888-888888888888" },
        СуммаДокумента: 11200,
        Комментарий: "Didox invoice 24",
        ВидОперации: "Товары",
      },
    });
    // What belonged to the earlier document alone is not carried over.
    for (const own of ["Номер", "Проведен", "ДокументОснование"])
      expect(change.fields).not.toHaveProperty(own);
    expect(change.tables?.Товары).toEqual([
      {
        Номенклатура: { type: "Справочник.Номенклатура", ref: ITEM_SOAP },
        Количество: 10,
        Цена: 1000,
        Сумма: 10000,
        СтавкаНДС: "НДС12",
        СуммаНДС: 1200,
        Всего: 11200,
        СчетУчета: { type: "ПланСчетов.Хозрасчетный", ref: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        СчетДоходов: { type: "ПланСчетов.Хозрасчетный", ref: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      },
    ]);
    expect(note).toContain("РТ-000007");
  });

  it("writes the amount with VAT in it when the company's sales do, and the item's own unit when it has one", async () => {
    const out = await run([invoice([line("Жидкое мыло")])], {
      sales: [{ ref: SALE_OLD, kind: "goods", buyer: true, over: { СуммаВключаетНДС: true } }],
    });
    expect(out.ready[0]?.change.tables?.Товары?.[0]).toMatchObject({
      Сумма: 11200,
      Цена: 1120,
      Всего: 11200,
    });
  });

  it("an act of services goes to the services table of a sale that has one", async () => {
    const act = parseDidoxDocument({
      actid: "act1",
      actdoc: { actno: "5", actdate: "2026-09-12" },
      sellertin: OWN_INN,
      seller: { name: "CRYSTAL" },
      buyertin: BUYER_INN,
      buyer: { name: "NAVRO'Z-PTK" },
      contractdoc: { contractno: "17", contractdate: "2025-08-08" },
      productlist: { hasvat: true, products: [line("Аренда офиса", { packagename: "услуга" })] },
    })!;
    // The buyer's last sale is of goods; another of the company's has services: that one is the template.
    const out = await run([act], {
      sales: [
        { ref: SALE_OLD, kind: "goods", buyer: true },
        { ref: SALE_SERVICES, kind: "services" },
      ],
    });
    expect(out.problems).toEqual([]);
    expect(out.ready[0]?.change.tables).toMatchObject({
      Услуги: [
        { Номенклатура: { ref: ITEM_RENT }, СчетДоходов: { ref: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
      ],
    });
    expect(out.ready[0]?.change.tables).not.toHaveProperty("Товары");
  });

  it("says so when the company has no sale of the kind to copy", async () => {
    const act = invoice([line("Аренда офиса", { packagename: "услуга" })]);
    const out = await run([act], { sales: [{ ref: SALE_OLD, kind: "goods", buyer: true }] });
    expect(out.ready).toEqual([]);
    expect(out.problems[0]).toMatchObject({ code: "NO_TEMPLATE" });
  });

  it("leaves out a sale 1C already has: the same buyer, day and amount", async () => {
    const out = await run([invoice([line("Жидкое мыло")])], {
      existing: [[BUYER_INN, "2026-09-10T00:00:00", 11200]],
    });
    expect(out.alreadyIn1c).toEqual([`${OWN_INN}/24`]);
    expect(out.ready).toEqual([]);
  });

  it("applies the accountant's VAT map when the base lacks the rate", async () => {
    const doc = invoice([line("Жидкое мыло", { vatrate: 12 })]);
    const missing = await run([doc], { vat: ["Без НДС", "15%"] });
    expect(missing.problems[0]).toMatchObject({ code: "VAT_RATE_MISSING" });
    const mapped = await run([doc], { vat: ["Без НДС", "15%"] }, { rules: { vatRateMap: { 12: 15 } } });
    expect(mapped.problems).toEqual([]);
    expect(mapped.ready[0]?.change.tables?.Товары?.[0]).toMatchObject({ СтавкаНДС: "НДС15", СуммаНДС: 1200 });
  });

  it("hands over what it cannot settle: a buyer 1C lacks, a contract, an item", async () => {
    const doc = invoice([line("Жидкое мыло")]);
    expect((await run([doc], { buyers: false })).problems[0]).toMatchObject({
      code: "COUNTERPARTY_NOT_FOUND",
    });
    expect(
      (await run([doc], { contracts: [[CONTRACT, "99", "2025-01-01T00:00:00"]] })).problems[0],
    ).toMatchObject({
      code: "CONTRACT_NOT_FOUND",
      candidates: [expect.objectContaining({ ref: CONTRACT })],
    });
    expect((await run([doc], { items: [] })).problems[0]).toMatchObject({ code: "ITEM_NOT_FOUND", line: 1 });
    // The model's answer for the item is taken as it is.
    const settled = await run(
      [doc],
      { items: [] },
      { overrides: { items: [{ document: `${OWN_INN}/24`, line: 1, ref: ITEM_SOAP }] } },
    );
    expect(settled.ready).toHaveLength(1);
  });

  it("refuses another company's document", async () => {
    const other = invoice([line("Жидкое мыло")], { sellertin: "312318957" });
    const out = await run([other]);
    expect(out.problems[0]).toMatchObject({ code: "NOT_THIS_COMPANY" });
  });
});
