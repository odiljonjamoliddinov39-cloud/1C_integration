/**
 * Attack: a year or three of a company's Didox documents as they really are: numbers that start again every year,
 * the same document sent twice, acts that repeat an invoice, corrections, one huge invoice. Nothing may be lost or
 * entered twice, every document keeps its own key, and a document's own figures decide whether it is entered.
 */
import { describe, expect, it } from "vitest";

import { batchOf, didoxKey, parseDidoxDocument, type DidoxDocument } from "../didox/document.js";
import { cases, Rng, seed } from "./rng.js";

function make(
  rng: Rng,
  kind: "invoice" | "act",
  seller: string,
  number: string,
  date: string,
  id: string,
  lines = rng.int(1, 5),
): DidoxDocument {
  const products = Array.from({ length: lines }, (_, k) => {
    const amount = rng.int(1, 5000) * 100;
    const vat = Math.round(amount * 0.12 * 100) / 100;
    return {
      ordno: k + 1,
      name: `Item ${k}`,
      count: "1",
      summa: String(amount),
      deliverysum: String(amount),
      vatrate: 12,
      vatsum: String(vat),
      deliverysumwithvat: String(amount + vat),
    };
  });
  const head =
    kind === "invoice"
      ? { facturaid: id, facturadoc: { facturano: number, facturadate: date }, facturatype: 0 }
      : { actid: id, actdoc: { actno: number, actdate: date } };
  const doc = parseDidoxDocument({
    ...head,
    sellertin: seller,
    seller: { name: "S" },
    buyertin: "300000001",
    buyer: { name: "B" },
    productlist: { hasvat: true, products },
  });
  if (!doc) throw new Error("not a Didox document");
  return doc;
}

describe("attack: Didox batches", () => {
  it("numbers that start again every year are different documents, each with its own key", () => {
    const rng = new Rng(seed(260));
    for (let i = 0; i < cases(1500); i++) {
      const sellers = ["312318957", "201607534", "305059982"];
      const docs: DidoxDocument[] = [];
      const truth = new Set<string>();
      for (let k = 0; k < rng.int(2, 40); k++) {
        const seller = rng.pick(sellers);
        const number = String(rng.int(1, 6));
        const date = rng.date(2024, 2026);
        const id = `${seller}-${number}-${date}`;
        if (truth.has(id)) continue;
        truth.add(id);
        docs.push(make(rng, "invoice", seller, number, date, id));
        // The same document sent twice (an archive and the API).
        if (rng.chance(0.2)) docs.push(make(rng, "invoice", seller, number, date, id));
      }
      const batch = batchOf(docs);
      expect(batch.postable.length, `${truth.size} different documents`).toBe(truth.size);
      const keys = batch.postable.map((d) => didoxKey(d));
      expect(new Set(keys).size, "every document has its own key").toBe(keys.length);
      // The same call again changes nothing: keys are stable.
      const again = batchOf(docs);
      expect(again.postable.map((d) => didoxKey(d))).toEqual(keys);
    }
  });

  it("an act that repeats an invoice is checked against it, not entered; an act with no invoice is entered", () => {
    const rng = new Rng(seed(261));
    for (let i = 0; i < cases(1500); i++) {
      const date = rng.date(2025, 2026);
      const invoice = make(rng, "invoice", "312318957", "7", date, "i1");
      const paired = make(rng, "act", "312318957", "7", date, "a1");
      const alone = make(rng, "act", "312318957", "8", date, "a2");
      const batch = batchOf(rng.shuffle([invoice, paired, alone]));
      expect(batch.pairedActs).toBe(1);
      expect(batch.postable.map((d) => d.kind).sort()).toEqual(["act", "invoice"]);
      // The paired act's different total is said, not lost.
      if (paired.totals.total !== invoice.totals.total)
        expect(invoice.issues.some((x) => x.code === "ACT_DIFFERS")).toBe(true);
    }
  });

  it("a very large invoice is read whole, to the tiyin", () => {
    const rng = new Rng(seed(262));
    const doc = make(rng, "invoice", "312318957", "1", "2026-01-01", "big", 1500);
    expect(doc.lines).toHaveLength(1500);
    expect(doc.totals.total).toBe(doc.lines.reduce((n, l) => n + l.total, 0));
    expect(doc.issues).toEqual([]);
  });
});
