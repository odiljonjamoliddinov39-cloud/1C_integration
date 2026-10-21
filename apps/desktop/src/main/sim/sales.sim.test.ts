/**
 * Simulation: thousands of the company's own Didox invoices and acts entered as sales. Whatever the lines, the sale
 * must carry exactly the document's lines and sums, in the right table; a document needing both goods and services
 * lines from a sale that has only one kind is refused, never half-made.
 */
import { describe, expect, it } from "vitest";

import { parseDidoxDocument } from "../didox/document.js";
import { resolveSales } from "../didox/sales.js";
import {
  BUYER_INN,
  ITEM_RENT,
  ITEM_SOAP,
  OWN_INN,
  SALE_OLD,
  SALE_SERVICES,
  deps,
  line,
} from "../didox/sales-fake.js";
import { cases, Rng, seed } from "./rng.js";

const money = (n: number) => n.toFixed(2);

describe("simulation: sales from Didox documents", () => {
  it("carry the document's lines and sums to the cent, in the right table", async () => {
    const rng = new Rng(seed(120));
    const bad: string[] = [];
    const n = cases(1500);
    for (let i = 0; i < n; i++) {
      const lines = Array.from({ length: rng.int(1, 8) }, (_, k) => {
        const service = rng.chance(0.4);
        const qty = rng.pick([1, 2, 5, 10, 12.5]);
        const price = rng.money(1, 900_000, true);
        const amount = Math.round(qty * price * 100) / 100;
        const rate = rng.pick([0, 12]);
        const vat = Math.round(amount * rate) / 100;
        return {
          service,
          json: line(service ? "Аренда офиса" : "Жидкое мыло", {
            ordno: k + 1,
            packagename: service ? "услуга" : "шт",
            count: String(qty),
            summa: money(price),
            deliverysum: money(amount),
            vatrate: rate,
            vatsum: money(vat),
            deliverysumwithvat: money(amount + vat),
          }),
        };
      });
      const mixed = lines.some((l) => l.service) && lines.some((l) => !l.service);
      const doc = parseDidoxDocument({
        facturaid: `x${i}`,
        facturadoc: { facturano: String(i + 1), facturadate: rng.date(2026, 2026) },
        facturatype: 0,
        sellertin: OWN_INN,
        seller: { name: "CRYSTAL" },
        buyertin: BUYER_INN,
        buyer: { name: "NAVRO'Z-PTK" },
        contractdoc: { contractno: "17", contractdate: "2025-08-08" },
        productlist: { hasvat: true, products: lines.map((l) => l.json) },
      });
      if (!doc) {
        bad.push(`#${i} not read`);
        continue;
      }
      const out = await resolveSales(
        [doc],
        { companyInn: OWN_INN },
        deps({
          sales: [
            { ref: SALE_OLD, kind: "goods", buyer: true },
            { ref: SALE_SERVICES, kind: "services" },
          ],
          vat: ["Без НДС", "12%"],
        }),
      );
      if (mixed) {
        // One sale cannot be both an earlier goods sale and a services one: refused, with the reason.
        if (out.ready.length !== 0 || out.problems[0]?.code !== "NO_TEMPLATE")
          bad.push(`#${i} mixed doc: ${JSON.stringify(out.problems[0])}`);
        continue;
      }
      const made = out.ready[0];
      if (!made) {
        bad.push(`#${i} ${JSON.stringify(out.problems[0])}`);
        continue;
      }
      const table = made.change.tables?.[lines[0]?.service ? "Услуги" : "Товары"] ?? [];
      if (table.length !== lines.length) bad.push(`#${i} ${table.length} rows for ${lines.length} lines`);
      const total = table.reduce((sum, r) => sum + Number(r["Всего"] ?? 0), 0);
      if (Math.abs(total - doc.totals.total / 100) > 0.011 * lines.length)
        bad.push(`#${i} rows ${total} vs ${doc.totals.total / 100}`);
      if (made.change.fields?.СуммаДокумента !== doc.totals.total / 100)
        bad.push(`#${i} header ${String(made.change.fields?.СуммаДокумента)}`);
      if (made.change.fields?.Дата !== doc.date) bad.push(`#${i} date`);
      const itemOk = table.every((r) =>
        [ITEM_SOAP, ITEM_RENT].includes((r["Номенклатура"] as { ref: string }).ref),
      );
      if (!itemOk) bad.push(`#${i} items`);
      // Nothing of the other table is filled, and the other table is not sent at all.
      if (Object.keys(made.change.tables ?? {}).length !== 1)
        bad.push(`#${i} tables ${Object.keys(made.change.tables ?? {}).join(",")}`);
    }
    expect(bad.slice(0, 10), `${bad.length} problems in ${n}`).toEqual([]);
  });
});
