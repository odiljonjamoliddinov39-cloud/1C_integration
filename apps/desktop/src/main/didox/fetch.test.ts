import { describe, expect, it } from "vitest";

import { DidoxClient } from "./client.js";
import { FakeDidox, FakeSigner } from "./fake.js";
import { documentJson, fetchDidoxDocuments, itemsOf } from "./fetch.js";

/** An ЭСФ as Didox gives it, cut down to the fields that matter. */
function invoice(number: string, date: string, sellerTin: string, buyerTin: string, total = "1000.00") {
  return {
    facturadoc: { facturano: number, facturadate: date },
    sellertin: sellerTin,
    seller: { name: `SELLER ${sellerTin}` },
    buyertin: buyerTin,
    buyer: { name: `BUYER ${buyerTin}` },
    productlist: {
      hasvat: false,
      products: [
        {
          ordno: 1,
          name: "Suv",
          count: "1",
          summa: total,
          deliverysum: total,
          vatrate: 0,
          vatsum: 0,
          deliverysumwithvat: total,
        },
      ],
    },
  };
}

function setup() {
  const server = new FakeDidox();
  const client = new DidoxClient({ baseUrl: "https://didox.test/", fetch: server.fetch }, new FakeSigner());
  return { server, client };
}

describe("Didox documents read through the API", () => {
  it("lists the incoming ones, reads each, and keeps those dated in the period", async () => {
    const { server, client } = setup();
    server.documents = [
      {
        id: "a",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2026-10-10 10:00:00",
        json: invoice("1", "2026-10-09", "111111111", "302936161"),
      },
      {
        id: "b",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2026-10-12 10:00:00",
        json: invoice("2", "2026-09-20", "111111111", "302936161"),
      },
      {
        id: "c",
        doctype: "002",
        status: 3,
        owner: 1,
        updated: "2026-10-12 10:00:00",
        json: invoice("3", "2026-10-11", "302936161", "222222222"),
      },
    ];
    const result = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2026-10-01",
      to: "2026-10-31",
      limit: 50,
    });
    expect(result.documents.map((d) => d.number)).toEqual(["1"]);
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("reads both directions, oldest first, and stops at the limit", async () => {
    const { server, client } = setup();
    server.documents = [
      {
        id: "a",
        doctype: "002",
        status: 3,
        owner: 0,
        json: invoice("2", "2026-10-02", "111111111", "302936161"),
      },
      {
        id: "b",
        doctype: "002",
        status: 3,
        owner: 1,
        json: invoice("1", "2026-10-01", "302936161", "222222222"),
      },
    ];
    const both = await fetchDidoxDocuments(client, { direction: "both", limit: 50 });
    expect(both.documents.map((d) => d.number)).toEqual(["1", "2"]);
    const one = await fetchDidoxDocuments(client, { direction: "both", limit: 1 });
    expect(one.documents).toHaveLength(1);
    expect(one.truncated).toBe(true);
  });

  it("says which documents Didox would not give", async () => {
    const { server, client } = setup();
    server.documents = [{ id: "a", doctype: "002", status: 3, owner: 0, json: { facturadoc: {} } }];
    server.documents.push({ id: "gone", doctype: "002", status: 3, owner: 0 });
    const result = await fetchDidoxDocuments(client, { direction: "incoming", limit: 10 });
    // The first is not a document the app reads; the second is listed and then refused.
    expect(result.documents).toHaveLength(0);
    expect(result.skipped + result.failed.length).toBe(2);
  });
});

describe("reading Didox's answers", () => {
  it("finds the list under any key, and the document in any wrapping", () => {
    expect(itemsOf({ data: [{ _id: "x" }] })).toHaveLength(1);
    expect(itemsOf([{ id: 1 }, { id: 2 }])).toHaveLength(2);
    const doc = invoice("1", "2026-10-01", "1", "2");
    expect(documentJson(doc)).toBe(doc);
    expect(documentJson({ data: doc })).toBe(doc);
    expect(documentJson({ json: JSON.stringify(doc) })).toEqual(doc);
    expect(documentJson({ id: "x" })).toBeNull();
  });
});
