import { describe, expect, it } from "vitest";

import type { DidoxDocument } from "./document.js";
import { fillFromSale, tinsByName } from "./enrich.js";

const advance = { name: "Аванс по договору №4/48", unit: "шт", qty: 1, price: 100, vatRate: 12 };
const sold = [
  { ikpu: "04818001001000000", name: "Туалетная бумага Elma", unit: "дона", sum: 500 },
  { ikpu: "04818001002000000", name: "Салфетки", unit: "дона", sum: 900 },
  { ikpu: "", name: "Без кода", unit: "дона", sum: 9999 },
];

describe("fillFromSale", () => {
  it("gives an advance line the code and unit of the buyer's biggest coded sale line", () => {
    const { lines, notes } = fillFromSale([advance], sold);
    expect(lines[0]).toMatchObject({
      catalogCode: "04818001002000000",
      catalogName: "Салфетки",
      unit: "дона",
    });
    expect(notes[0]).toContain("04818001002000000");
  });

  it("keeps a line that has its own code, and the unit of a goods line", () => {
    const own = { ...advance, name: "Салфетки", catalogCode: "111", unit: "кг" };
    const goods = { ...advance, name: "Салфетки" };
    const { lines } = fillFromSale([own, goods], sold);
    expect(lines[0]).toEqual(own);
    expect(lines[1]).toMatchObject({ catalogCode: "04818001002000000", unit: "шт" });
  });

  it("invents nothing when the buyer has no coded sale", () => {
    expect(fillFromSale([advance], [sold[2] as (typeof sold)[number]])).toEqual({
      lines: [advance],
      notes: [],
    });
    expect(fillFromSale([advance], [{ ikpu: "123", name: "x", unit: "шт", sum: 1 }]).notes).toEqual([]);
  });
});

const doc = (buyerTin: string, buyerName: string, sellerName = "CRYSTAL WATER TRADE MCHJ") =>
  ({
    buyer: { tin: buyerTin, name: buyerName },
    seller: { tin: "303212825", name: sellerName },
  }) as DidoxDocument;

describe("tinsByName", () => {
  it("finds the buyer's INN by its name, however the legal form is written", () => {
    const docs = [doc("200433208", 'ООО "DOM FRESH WASHING"'), doc("201607534", "NAVRO'Z-PTK MCHJ")];
    expect(tinsByName(docs, "DOM FRESH WASHING")).toEqual([
      { tin: "200433208", name: 'ООО "DOM FRESH WASHING"' },
    ]);
    expect(tinsByName(docs, 'OOO "Dom Fresh Washing"')).toHaveLength(1);
  });

  it("lists each INN once and skips empty or zero INNs and other names", () => {
    const docs = [
      doc("200433208", "DOM FRESH"),
      doc("200433208", "DOM FRESH"),
      doc("000000000", "DOM FRESH"),
    ];
    expect(tinsByName(docs, "dom fresh")).toHaveLength(1);
    expect(tinsByName(docs, "Other")).toEqual([]);
    expect(tinsByName(docs, "")).toEqual([]);
  });
});
