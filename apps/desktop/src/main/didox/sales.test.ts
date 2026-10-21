import { describe, expect, it } from "vitest";

import {
  BUYER,
  BUYER_INN,
  CONTRACT,
  ITEM_RENT,
  ITEM_SOAP,
  OWN_INN,
  SALE_OLD,
  SALE_SERVICES,
  type World,
  deps,
  invoice,
  line,
} from "./sales-fake.js";
import { parseDidoxDocument } from "./document.js";
import { resolveSales } from "./sales.js";

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
