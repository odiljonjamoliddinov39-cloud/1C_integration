import { describe, expect, it } from "vitest";

import { buildInvoiceDraft, draftIdOf, findMeasure, partyFromProfile } from "./outgoing.js";

const seller = partyFromProfile("303212825", {
  name: "CRYSTAL WATER TRADE MCHJ",
  account: "20208000100438330001",
  mfo: "00450",
  address: "ТАШКЕНТ",
  oked: 46170,
  directorTin: "476110034",
  director: "АЛИМОВ М.Н.",
})!;
const buyer = partyFromProfile("201607534", {
  data: { name: "NAVRO'Z-PTK MCHJ", Account: "20208000", MFO: "00014" },
})!;
const measures = [
  { id: "1", name: "шт" },
  { id: "2", name: "кг" },
];

const input = {
  number: "1294",
  date: "2026-10-19",
  buyerTin: "201607534",
  contract: { number: "12", date: "2026-01-10" },
  lines: [
    { name: "Suv 19 l", unit: "шт.", qty: 3, price: 25000, vatRate: 12 },
    { name: "Idish", unit: "кг", qty: 2.5, price: 1000.5, vatRate: 0 },
  ],
};

describe("party from a Didox profile", () => {
  it("reads the fields however they are cased and wrapped", () => {
    expect(seller).toMatchObject({ name: "CRYSTAL WATER TRADE MCHJ", bankId: "00450", oked: "46170" });
    expect(buyer).toMatchObject({ account: "20208000", bankId: "00014" });
  });
  it("is null when the answer has no name", () => {
    expect(partyFromProfile("1", { error: "x" })).toBeNull();
  });
});

describe("units", () => {
  it("are found by name, ignoring case and dots", () => {
    expect(findMeasure(measures, "ШТ.")).toBe("1");
    expect(findMeasure({ data: measures }, "кг")).toBe("2");
    expect(findMeasure(measures, "litr")).toBeNull();
  });
});

describe("invoice draft", () => {
  it("works the sums out in tiyin and lays the body out as Didox's library does", () => {
    const result = buildInvoiceDraft(input, seller, buyer, measures);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    const { body, preview } = result.built;
    expect(preview.lines.map((l) => [l.amount, l.vat, l.total])).toEqual([
      ["75000.00", "9000.00", "84000.00"],
      ["2501.25", "0.00", "2501.25"],
    ]);
    expect(preview.totals).toEqual({ amount: "77501.25", vat: "9000.00", total: "86501.25" });
    expect(body).toMatchObject({
      FacturaType: 0,
      FacturaDoc: { FacturaNo: "1294", FacturaDate: "2026-10-19" },
      ContractDoc: { ContractNo: "12", ContractDate: "2026-01-10" },
      SellerTin: "303212825",
      BuyerTin: "201607534",
      products_total_sum: 86501.25,
    });
    const products = (body.ProductList as { Products: Record<string, unknown>[] }).Products;
    expect(products[0]).toMatchObject({
      OrdNo: 1,
      MeasureId: "1",
      DeliverySumWithVat: 84000,
      WithoutVat: false,
    });
    expect(products[1]).toMatchObject({ MeasureId: "2", WithoutVat: true });
  });

  it("names everything that is wrong, line by line", () => {
    const result = buildInvoiceDraft(
      {
        ...input,
        number: " ",
        date: "19.10.2026",
        buyerTin: "12",
        lines: [
          { name: "A", unit: "litr", qty: 1, price: 1, vatRate: 12 },
          { name: "B", unit: "шт", qty: 0, price: 1, vatRate: 12 },
        ],
      },
      seller,
      null,
      measures,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => `${p.code}:${p.line}`)).toEqual([
      "NO_NUMBER:null",
      "BAD_DATE:null",
      "BAD_TIN:null",
      "NO_UNIT:1",
      "BAD_LINE:2",
    ]);
  });

  it("refuses when Didox has no company with the buyer's INN", () => {
    const result = buildInvoiceDraft(input, seller, null, measures);
    expect(result).toMatchObject({ ok: false, problems: [{ code: "NO_PARTY" }] });
  });
});

describe("the answer to a creation", () => {
  it("has the draft's id", () => {
    expect(draftIdOf({ _id: "D1" })).toBe("D1");
    expect(draftIdOf({ data: { id: "D2" } })).toBe("D2");
    expect(draftIdOf("false")).toBeNull();
  });
});
