import { describe, expect, it } from "vitest";

import { DidoxClient } from "./client.js";
import { FakeDidox, FakeSigner } from "./fake.js";
import { documentJson, explainEmpty, fetchDidoxDocuments, itemsOf } from "./fetch.js";

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

  it("finds a month long past among the documents issued since, which must not use up the limit", async () => {
    const { server, client } = setup();
    // 150 documents of this year, newest first, then three of January 2024.
    const recent = Array.from({ length: 150 }, (_, i) => ({
      id: `n${i}`,
      doctype: "002",
      status: 3,
      owner: 0 as const,
      updated: "2026-10-10 10:00:00",
      docdate: "2026-10-09",
      json: invoice(`N${i}`, "2026-10-09", "111111111", "302936161"),
    }));
    const january = ["1", "2", "3"].map((n) => ({
      id: `j${n}`,
      doctype: "002",
      status: 3,
      owner: 0 as const,
      updated: "2024-02-01 10:00:00",
      docdate: "2024-01-31",
      json: invoice(`J${n}`, "2024-01-31", "111111111", "302936161"),
    }));
    server.documents = [...recent, ...january];
    const result = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2024-01-01",
      to: "2024-01-31",
      limit: 10,
    });
    expect(result.documents.map((d) => d.number)).toEqual(["J1", "J2", "J3"]);
    expect(result.truncated).toBe(false);
  });

  it("says why nothing was read: how far back Didox's list goes, what it could not read, what is newer", async () => {
    const { server, client } = setup();
    // Didox holds this company's documents of 2025-2026 only, plus one of a kind the app does not read.
    const recent = Array.from({ length: 3 }, (_, i) => ({
      id: `r${i}`,
      doctype: "002",
      status: 3,
      owner: 0 as const,
      updated: "2025-03-01 10:00:00",
      docdate: "2025-03-01",
      json: invoice(`R${i}`, "2025-03-01", "111111111", "302936161"),
    }));
    server.documents = recent;

    // 2020-2023: nothing older than 2025 in Didox's list: the answer says so (and not "not connected").
    const old = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2020-01-01",
      to: "2023-12-31",
      limit: 50,
    });
    expect(old.documents).toEqual([]);
    expect(old.newerThanPeriod).toBe(3);
    expect(old.oldestListed).toBe("2025-03-01");
    const why = explainEmpty(old, "2020-01-01", "2023-12-31");
    expect(why).toContain("3 listed documents are dated after 2023-12-31");
    expect(why).toContain("goes back only to 2025-03-01");
    expect(why).toContain("archive");
    expect(why).not.toMatch(/not connected/i);

    // A period Didox does hold: nothing to explain.
    const now = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2025-01-01",
      to: "2025-12-31",
      limit: 50,
    });
    expect(now.documents).toHaveLength(3);
    expect(explainEmpty(now, "2025-01-01", "2025-12-31")).toBe("");
  });

  it("tells an empty list and documents it cannot read apart", async () => {
    const empty = {
      documents: [],
      listed: 0,
      skipped: 0,
      unreadable: 0,
      outsidePeriod: 0,
      newerThanPeriod: 0,
      oldestListed: "",
      newestListed: "",
      pagesRead: 0,
      stoppedAtPageLimit: false,
      failed: [],
      truncated: false,
    };
    expect(explainEmpty(empty, "2020-01-01", "2020-12-31")).toContain("list for this direction was empty");
    const unread = {
      ...empty,
      pagesRead: 1,
      listed: 19,
      unreadable: 19,
      skipped: 19,
      oldestListed: "2020-02-01",
    };
    expect(explainEmpty(unread, "2020-01-01", "2020-12-31")).toContain(
      "19 documents were found in the period",
    );
    const deep = { ...empty, pagesRead: 100, stoppedAtPageLimit: true, oldestListed: "2024-05-01" };
    expect(explainEmpty(deep, "2020-01-01", "2023-12-31")).toContain("stopped at the most pages");
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
