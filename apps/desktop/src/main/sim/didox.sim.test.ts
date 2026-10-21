/**
 * Simulation: thousands of generated Didox invoices and acts as the service exports them: numbers as numbers or as
 * text, floats with noise, 0 / 12 / 15 % VAT or no VAT, any quantities and prices. A consistent document must read
 * with no issue and exact tiyin; one with a wrong figure must say so; nothing may throw.
 */
import { describe, expect, it } from "vitest";

import { batchOf, parseDidoxDocument } from "../didox/document.js";
import { cases, Rng, seed } from "./rng.js";

const noisy = (rng: Rng, n: number, decimals = 2): number | string => {
  const text = n.toFixed(decimals);
  const style = rng.int(0, 3);
  if (style === 0) return Number(text);
  if (style === 1) return text;
  if (style === 2) return Number(text) + 1e-13;
  return text.replace(".", ",");
};

interface Made {
  json: Record<string, unknown>;
  lines: { qty: number; price: number; rate: number }[];
}

function invoice(rng: Rng, kind: "invoice" | "act"): Made {
  const hasVat = rng.chance(0.85);
  const lines = Array.from({ length: rng.int(1, 12) }, () => ({
    qty: rng.pick([1, 1, 2, 3, 10, 12.5, 0.5, 100, 250]),
    price: rng.money(1, 5_000_000, true),
    rate: hasVat ? rng.pick([12, 15, 0]) : 0,
  }));
  const products = lines.map((l, i) => {
    const amount = Math.round(l.qty * l.price * 100) / 100;
    const vat = Math.round(amount * l.rate) / 100;
    return {
      ordno: i + 1,
      name: `  Item ${i}\t`,
      catalogcode: "10403003014000001",
      packagename: rng.pick(["шт", "услуга (сум)", "кг", "м²"]),
      count: noisy(rng, l.qty, 3),
      summa: noisy(rng, l.price),
      deliverysum: noisy(rng, amount),
      vatrate: hasVat ? (rng.chance(0.3) ? String(l.rate) : l.rate) : 0,
      vatsum: noisy(rng, vat),
      deliverysumwithvat: noisy(rng, amount + vat),
      ...(hasVat ? {} : { withoutvat: true }),
    };
  });
  const head =
    kind === "invoice"
      ? { facturadoc: { facturano: String(rng.int(1, 999)), facturadate: rng.date() }, facturatype: 0 }
      : { actdoc: { actno: String(rng.int(1, 999)), actdate: rng.date() } };
  return {
    json: {
      ...head,
      ...(kind === "invoice" ? { facturaid: rng.digits(12) } : { actid: rng.digits(12) }),
      sellertin: "312318957",
      seller: { name: "SELLER MCHJ" },
      buyertin: "311012912",
      buyer: { name: "BUYER MCHJ" },
      contractdoc: { contractno: "17", contractdate: "2025-08-08" },
      productlist: { hasvat: hasVat, products },
    },
    lines,
  };
}

describe("simulation: Didox documents are read to the tiyin", () => {
  it("a consistent invoice or act reads without an issue, with the right lines and totals", () => {
    const rng = new Rng(seed(90));
    const bad: string[] = [];
    for (let i = 0; i < cases(5000); i++) {
      const made = invoice(rng, rng.pick(["invoice", "act"]));
      const doc = parseDidoxDocument(made.json);
      if (!doc) {
        bad.push(`#${i} not read`);
        continue;
      }
      if (doc.issues.length) bad.push(`#${i} issues: ${doc.issues.map((x) => x.message).join(" | ")}`);
      if (doc.lines.length !== made.lines.length) bad.push(`#${i} ${doc.lines.length} lines`);
      let amount = 0;
      let vat = 0;
      made.lines.forEach((l, k) => {
        const got = doc.lines[k];
        if (!got) return;
        const a = Math.round(l.qty * l.price * 100);
        amount += a;
        vat += Math.round((a * l.rate) / 100);
        if (got.qty !== l.qty || got.price !== Math.round(l.price * 100))
          bad.push(`#${i} line ${k} qty/price`);
        if (got.vatRate !== l.rate) bad.push(`#${i} line ${k} rate ${got.vatRate} ≠ ${l.rate}`);
      });
      if (Math.abs(doc.totals.amount - amount) > made.lines.length)
        bad.push(`#${i} amount ${doc.totals.amount} ≠ ${amount}`);
      if (Math.abs(doc.totals.vat - vat) > made.lines.length)
        bad.push(`#${i} vat ${doc.totals.vat} ≠ ${vat}`);
      if (Math.abs(doc.totals.total - (doc.totals.amount + doc.totals.vat)) > made.lines.length)
        bad.push(`#${i} total`);
    }
    expect(bad.slice(0, 10), `${bad.length} problems`).toEqual([]);
  });

  it("a wrong figure is named, and a batch of documents never throws", () => {
    const rng = new Rng(seed(91));
    let flagged = 0;
    let broken = 0;
    const docs: NonNullable<ReturnType<typeof parseDidoxDocument>>[] = [];
    for (let i = 0; i < cases(3000); i++) {
      const made = invoice(rng, "invoice");
      const products = (made.json["productlist"] as { products: Record<string, unknown>[] }).products;
      const target = rng.pick(products);
      const field = rng.pick(["deliverysum", "vatsum", "deliverysumwithvat"] as const);
      // Only a change of a figure that matters: more than the tolerance of a tiyin or two.
      const wrong = Number(target[field]) + rng.pick([1000, -1000, 55.55]);
      if (!Number.isFinite(wrong) || wrong < 0) continue;
      target[field] = wrong;
      broken++;
      const doc = parseDidoxDocument(made.json);
      if (doc && doc.issues.length > 0) flagged++;
      if (doc) docs.push(doc);
    }
    expect(flagged).toBe(broken);
    expect(() => batchOf(docs.slice(0, 200))).not.toThrow();
  });

  it("junk is no document and no crash", () => {
    const rng = new Rng(seed(92));
    const junk: unknown[] = [
      null,
      undefined,
      1,
      "x",
      [],
      {},
      { facturadoc: null },
      { facturadoc: {}, productlist: "x" },
      { actdoc: { actno: 5 }, productlist: { products: [null, 1, "x", {}] } },
    ];
    for (let i = 0; i < cases(2000); i++) {
      const value = rng.pick(junk);
      expect(() => parseDidoxDocument(value)).not.toThrow();
    }
  });
});
