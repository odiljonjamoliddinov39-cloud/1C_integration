import { describe, expect, it } from "vitest";

import type { RunQueryInput } from "@platform/shared";

import { parseDidoxDocument } from "./document.js";
import type { QueryOutcome, ResolverDeps } from "./resolve.js";
import { readSaleKit } from "./sale-kit.js";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
const ok = (rows: unknown[][]): QueryOutcome => ({ ok: true, data: { columns: [], rows, truncated: false } });
const fail: QueryOutcome = { ok: false, code: "QUERY_ERROR", message: "no" };

const doc = parseDidoxDocument({
  facturatype: 0,
  facturadoc: { facturano: "2", facturadate: "2024-05-07" },
  sellertin: "311012912",
  seller: { name: "TEXMASH" },
  buyertin: "307816821",
  buyer: { name: "BUXMEXMASH" },
  productlist: {
    products: [
      {
        ordno: 1,
        name: "Корпус пикобура",
        count: "500",
        summa: "420000",
        deliverysum: "210000000",
        vatrate: 12,
        vatsum: "25200000",
        deliverysumwithvat: "235200000",
      },
    ],
  },
})!;

function fake(over: (q: RunQueryInput) => QueryOutcome | undefined = () => undefined): ResolverDeps {
  return {
    async query(input) {
      const custom = over(input);
      if (custom) return custom;
      const q = input.query;
      if (q.includes("Справочник.Склады"))
        return ok([[ref("Справочник.Склады", "w1", "Главный склад"), "Главный склад"]]);
      if (q.includes("Справочник.Контрагенты"))
        return ok([[ref("Справочник.Контрагенты", "c1", "BUXMEXMASH"), "BUXMEXMASH", "307816821"]]);
      if (q.includes("ДоговорыКонтрагентов"))
        return ok([
          [
            ref("Справочник.ДоговорыКонтрагентов", "d1", "x"),
            "307816821",
            "BMM-TI-01",
            "2024-02-23T00:00:00",
            ref("e", "СПокупателем", "С покупателем"),
          ],
        ]);
      if (q.includes("Справочник.Номенклатура"))
        return ok([
          [
            ref("Справочник.Номенклатура", "n1", "Корпус пикобура"),
            "Корпус пикобура",
            ref("e", "шт", "шт"),
            ref("e", "БезНДС", "Без НДС"),
            false,
          ],
        ]);
      if (q.includes("Перечисление.СтавкиНДС")) return ok([["Без НДС"], ["15%"]]);
      if (q.includes("ПЕРВЫЕ 30")) return ok([]);
      if (q.includes("ПЕРВЫЕ 1 ")) return ok([]);
      return fail;
    },
    async describe() {
      return fail;
    },
  };
}

describe("readSaleKit", () => {
  it("gives the warehouse, the buyer with its contracts, the items, the rates and the sales in one text", async () => {
    const text = await readSaleKit(fake(), [doc]);
    expect(text).toContain("Warehouses: Главный склад [w1]");
    expect(text).toContain(
      "Buyer BUXMEXMASH (INN 307816821): [c1]; contracts: №BMM-TI-01 of 2024-02-23 (С покупателем) [d1]",
    );
    expect(text).toContain("«Корпус пикобура»: [n1] unit шт, VAT Без НДС, goods");
    expect(text).toContain("VAT rates the base has: Без НДС, 15%. On the Didox lines: 12%.");
    expect(text).toContain("The base has no 12%");
    expect(text).toContain("No sales in 1C for 2024-05-07 – 2024-05-07.");
    expect(text).toContain("1C has no posted sale to copy");
  });

  it("says what is missing: no buyer, no contract, no item", async () => {
    const text = await readSaleKit(
      fake((q) =>
        q.query.includes("Справочник.Контрагенты") || q.query.includes("Справочник.Номенклатура")
          ? ok([])
          : undefined,
      ),
      [doc],
    );
    expect(text).toContain("not in 1C, create it first");
    expect(text).toContain("«Корпус пикобура»: not in 1C");
  });

  it("leaves out what could not be read and still gives the rest", async () => {
    const text = await readSaleKit(
      fake((q) => (q.query.includes("Справочник.Склады") ? fail : undefined)),
      [doc],
    );
    expect(text).not.toContain("Warehouses");
    expect(text).toContain("Buyer BUXMEXMASH");
  });

  it("gives nothing for documents that are not invoices or acts", async () => {
    expect(await readSaleKit(fake(), [])).toBe("");
  });
});
