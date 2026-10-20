import { describe, expect, it } from "vitest";

import { batchOf, describeBatch, isDidoxJson, money, parseDidoxDocument } from "./document.js";

const party = { name: '"TEST SELLER" MCHJ' };
const buyer = { name: '"TEST BUYER" MCHJ' };

/** An ЭСФ the way Didox exports it, cut down to the fields that matter. */
function invoice(over: Record<string, unknown> = {}, products?: Record<string, unknown>[]) {
  return {
    facturatype: 0,
    facturadoc: { facturano: "24", facturadate: "2026-01-01" },
    contractdoc: { contractno: "120", contractdate: "2025-08-08" },
    sellertin: "312318957",
    seller: party,
    buyertin: "311012912",
    buyer,
    productlist: {
      hasvat: true,
      products: products ?? [
        {
          ordno: 1,
          name: "Услуга\t",
          catalogcode: "10403003014000001",
          catalogname: "Банковская услуга",
          packagename: "услуга (сум)",
          count: "1",
          summa: "892.86",
          deliverysum: "892.86",
          vatrate: 12,
          vatsum: 107.14,
          deliverysumwithvat: "1000.00",
        },
      ],
    },
    ...over,
  };
}

describe("parseDidoxDocument", () => {
  it("reads an invoice into whole tiyin and checks it", () => {
    const doc = parseDidoxDocument(invoice());
    expect(doc).toMatchObject({
      kind: "invoice",
      number: "24",
      date: "2026-01-01",
      seller: { tin: "312318957", name: '"TEST SELLER" MCHJ' },
      buyer: { tin: "311012912" },
      contract: { number: "120", date: "2025-08-08" },
      totals: { amount: 89286, vat: 10714, total: 100000 },
      issues: [],
    });
    expect(doc?.lines[0]).toMatchObject({ n: 1, name: "Услуга", qty: 1, price: 89286, vatRate: 12 });
  });

  it("is not thrown off by float noise, numbers sent as strings, or a VAT rate sent as text", () => {
    const doc = parseDidoxDocument(
      invoice({}, [
        {
          ordno: 1,
          name: "x",
          count: "1",
          summa: JSON.parse("892.8600000000000136424205265939235687255859375"),
          deliverysum: "892.8600000000000136424205265939235687255859375",
          vatrate: "12",
          vatsum: "107.14",
          deliverysumwithvat: JSON.parse("1000.0000000000000136"),
        },
      ]),
    );
    expect(doc?.issues).toEqual([]);
    expect(doc?.totals.total).toBe(100000);
  });

  it("names a line whose amount, VAT or total does not add up, and no other", () => {
    const doc = parseDidoxDocument(
      invoice({}, [
        {
          ordno: 1,
          name: "ok",
          count: "2",
          summa: "100",
          deliverysum: "200",
          vatrate: 12,
          vatsum: 24,
          deliverysumwithvat: "224",
        },
        {
          ordno: 2,
          name: "bad amount",
          count: "3",
          summa: "100",
          deliverysum: "350",
          vatrate: 12,
          vatsum: 42,
          deliverysumwithvat: "392",
        },
        {
          ordno: 3,
          name: "bad vat",
          count: "1",
          summa: "100",
          deliverysum: "100",
          vatrate: 12,
          vatsum: 15,
          deliverysumwithvat: "115",
        },
        {
          ordno: 4,
          name: "bad total",
          count: "1",
          summa: "100",
          deliverysum: "100",
          vatrate: 0,
          vatsum: 0,
          deliverysumwithvat: "101",
        },
      ]),
    );
    expect(doc?.issues.map((i) => [i.line, i.code])).toEqual([
      [2, "LINE_AMOUNT"],
      [3, "LINE_VAT"],
      [4, "LINE_TOTAL"],
    ]);
    expect(doc?.issues[0]?.message).toBe("3 × 100.00 = 300.00, the document says 350.00");
  });

  it("allows the half tiyin a price rounded to two decimals can be off by, per unit", () => {
    // 1 000 000 units at a price of 0.01 (really 0.0104): the supplier's amount is 10 400.00.
    const doc = parseDidoxDocument(
      invoice({}, [
        {
          ordno: 1,
          name: "x",
          count: "1000000",
          summa: "0.01",
          deliverysum: "10000.40",
          vatrate: 0,
          vatsum: 0,
          deliverysumwithvat: "10000.40",
        },
      ]),
    );
    expect(doc?.issues).toEqual([]);
  });

  it("shows an unusual VAT rate and a bad INN without refusing the document", () => {
    const doc = parseDidoxDocument(
      invoice({ sellertin: "12345" }, [
        {
          ordno: 1,
          name: "x",
          count: "1",
          summa: "100",
          deliverysum: "100",
          vatrate: 15,
          vatsum: 15,
          deliverysumwithvat: "115",
        },
      ]),
    );
    expect(doc?.issues.map((i) => i.code)).toEqual(["TIN_FORMAT", "VAT_RATE"]);
  });

  it("reads a line with no VAT in it as a line without VAT, not as a mismatch", () => {
    const doc = parseDidoxDocument(
      invoice({}, [
        // The supplier flagged it, though a rate is written beside it.
        {
          ordno: 1,
          name: "flagged",
          count: "1",
          summa: "100",
          deliverysum: "100",
          vatrate: 12,
          withoutvat: true,
          deliverysumwithvat: "100",
        },
        // No VAT charged: the total is the amount.
        {
          ordno: 2,
          name: "none charged",
          count: "1",
          summa: "100",
          deliverysum: "100",
          vatrate: 12,
          vatsum: 0,
          deliverysumwithvat: "100",
        },
      ]),
    );
    expect(doc?.issues).toEqual([]);
    expect(doc?.lines.map((l) => [l.vatRate, l.vat, l.total])).toEqual([
      [0, 0, 10000],
      [0, 0, 10000],
    ]);
  });

  it("still shows a line whose VAT is written and does not add up", () => {
    const doc = parseDidoxDocument(
      invoice({}, [
        {
          ordno: 1,
          name: "x",
          count: "1",
          summa: "100",
          deliverysum: "100",
          vatrate: 12,
          vatsum: 15,
          deliverysumwithvat: "115",
        },
      ]),
    );
    expect(doc?.issues.map((i) => i.code)).toEqual(["LINE_VAT"]);
  });

  it("accepts a person's 14-digit PINFL", () => {
    expect(parseDidoxDocument(invoice({ sellertin: "31610976740015" }))?.issues).toEqual([]);
  });

  it("notes a corrective invoice and a type code", () => {
    const doc = parseDidoxDocument(
      invoice({ facturatype: "8", oldfacturadoc: { oldfacturano: "20", oldfacturadate: "2025-12-01" } }),
    );
    expect(doc?.notes).toEqual(["invoice type 8", "corrects invoice 20 of 2025-12-01"]);
  });

  it("reads an act, a contract, a free-form document and a reconciliation act", () => {
    const act = parseDidoxDocument({
      actdoc: { actno: "24", actdate: "2026-01-01" },
      contractdoc: { contractno: "120", contractdate: "2025-08-08" },
      sellertin: "312318957",
      sellername: "S",
      buyertin: "311012912",
      buyername: "B",
      productlist: {
        products: [
          {
            ordno: 1,
            name: "x",
            count: "1",
            summa: "1320000",
            totalsumwithoutvat: "1320000.00",
            vatrate: 0,
            vatsum: 0,
            totalsum: "1320000.00",
          },
        ],
      },
    });
    expect(act).toMatchObject({ kind: "act", number: "24", totals: { total: 132000000 }, issues: [] });

    const contract = parseDidoxDocument({
      contractdoc: { contractno: "5094-S", contractdate: "2025-12-24", contractexpiredate: "2025-12-31" },
      owner: { tin: "308799487", name: "UNITEST" },
      clients: [{ tin: "311012912", name: "B" }],
      parts: [],
    });
    expect(contract).toMatchObject({
      kind: "contract",
      number: "5094-S",
      seller: { tin: "308799487" },
      buyer: { tin: "311012912" },
    });

    const free = parseDidoxDocument({
      document: { documentno: "3", documentdate: "2025-12-23" },
      subtype: 6,
      documentid: "aa",
      sellertin: "203607858",
      seller: { name: "S" },
      buyertin: "311012912",
      buyer: { name: "B" },
      filename: "328_30.pdf",
    });
    expect(free).toMatchObject({ kind: "free", number: "3", fileName: "328_30.pdf" });

    const reconciliation = parseDidoxDocument({
      verificationactdoc: { verificationactno: "1" },
      ownertin: "311012912",
      ownername: "B",
      partnertin: "308799487",
      partnername: "S",
    });
    expect(reconciliation?.kind).toBe("reconciliation");
  });

  it("leaves other JSON alone", () => {
    expect(parseDidoxDocument({ name: "package.json", version: "1.0.0" })).toBeNull();
    expect(parseDidoxDocument([1, 2])).toBeNull();
    expect(parseDidoxDocument("text")).toBeNull();
    expect(isDidoxJson(invoice())).toBe(true);
    expect(isDidoxJson({ a: 1 })).toBe(false);
  });

  it("survives an invoice with missing fields", () => {
    const doc = parseDidoxDocument({ facturadoc: {}, productlist: {} });
    expect(doc?.issues.map((i) => i.code)).toEqual(["NO_NUMBER", "NO_LINES"]);
  });
});

describe("money", () => {
  it("writes tiyin as sum with two decimals", () => {
    expect(money(132000000)).toBe("1320000.00");
    expect(money(5)).toBe("0.05");
    expect(money(-1050)).toBe("-10.50");
  });
});

describe("batchOf and describeBatch", () => {
  const act = (number: string, total: string) => ({
    actdoc: { actno: number, actdate: "2026-01-01" },
    sellertin: "312318957",
    sellername: "S",
    buyertin: "311012912",
    buyername: "B",
    productlist: {
      products: [
        {
          ordno: 1,
          name: "x",
          count: "1",
          summa: total,
          totalsumwithoutvat: total,
          vatrate: 0,
          vatsum: 0,
          totalsum: total,
        },
      ],
    },
  });
  const noVat = (number: string, total: string) =>
    invoice({ facturadoc: { facturano: number, facturadate: "2026-01-01" } }, [
      {
        ordno: 1,
        name: "x",
        count: "1",
        summa: total,
        deliverysum: total,
        vatrate: 0,
        vatsum: 0,
        deliverysumwithvat: total,
      },
    ]);

  it("leaves out an act that repeats its invoice, and an invoice sent twice", () => {
    const docs = [noVat("24", "100"), noVat("24", "100"), act("24", "100"), act("25", "50")].map((j) =>
      parseDidoxDocument(j)!,
    );
    const batch = batchOf(docs);
    expect(batch.postable.map((d) => `${d.kind} ${d.number}`)).toEqual(["invoice 24", "act 25"]);
    expect(batch.pairedActs).toBe(1);
  });

  it("flags an invoice whose act comes to another total", () => {
    const batch = batchOf([noVat("24", "100"), act("24", "90")].map((j) => parseDidoxDocument(j)!));
    expect(batch.postable[0]?.issues.map((i) => i.code)).toEqual(["ACT_DIFFERS"]);
  });

  it("describes the batch briefly: the buyer once, one line per goods line, the result of the checks", () => {
    const docs = [
      invoice(),
      invoice({ facturadoc: { facturano: "25", facturadate: "2026-01-02" } }, [
        {
          ordno: 1,
          name: "wrong",
          count: "2",
          summa: "100",
          deliverysum: "250",
          vatrate: 0,
          vatsum: 0,
          deliverysumwithvat: "250",
        },
      ]),
      {
        contractdoc: { contractno: "5", contractdate: "2025-12-24" },
        owner: { tin: "308799487", name: "UNITEST" },
        clients: [{ tin: "311012912", name: "B" }],
        parts: [],
      },
    ].map((j) => parseDidoxDocument(j)!);
    const text = describeBatch(batchOf(docs));
    expect(text).toContain("2 to post, 1 for reference only");
    expect(text.match(/Buyer in all/g)).toHaveLength(1);
    expect(text).toContain('SELLER "TEST SELLER" MCHJ (INN 312318957): 2 document(s)');
    expect(text).toContain("INVOICE 24 of 2026-01-01 [312318957/24]");
    expect(text).toContain("1|Услуга|10403003014000001|услуга (сум)|1|892.86|12|107.14|1000.00");
    expect(text).toContain("sum without VAT 892.86, VAT 107.14, total 1000.00 — OK");
    expect(text).toContain("CHECK line 1: 2 × 100.00 = 200.00, the document says 250.00");
    expect(text).toContain("10403003014000001 = Банковская услуга");
    expect(text).toContain("contract 5 of 2025-12-24");
    expect(text).toContain("1 of 2 document(s) have lines to check");
  });
});
