import { describe, expect, it } from "vitest";

import { DidoxClient, DidoxError } from "./client.js";
import { FakeDidox, FakeSigner } from "./fake.js";
import {
  documentJson,
  explainEmpty,
  fetchDidoxDocuments,
  isDay,
  itemsOf,
  partialNote,
  windowsOf,
} from "./fetch.js";

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
      seen: 0,
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

  it("finds the way Didox takes a date, and reaches documents older than the window it falls back to", async () => {
    const { server, client } = setup();
    // Didox takes DD.MM.YYYY; a date written otherwise is dropped and its list holds only the current year.
    server.dateFormat = "dmy";
    server.defaultFrom = "2026-01-01";
    server.documents = [
      {
        id: "new",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2026-03-02 10:00:00",
        json: invoice("9", "2026-03-01", "1", "302936161"),
      },
      {
        id: "old",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2020-04-13 10:00:00",
        json: invoice("1", "2020-04-12", "1", "302936161"),
      },
    ];
    const result = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2020-01-01",
      to: "2020-12-31",
      limit: 100,
      today: "2026-11-10",
    });
    expect(result.dateFilter).toBe(true);
    expect(result.documents.map((d) => d.number)).toEqual(["1"]);
  });

  it("says so when no way of writing the date changes Didox's answer", async () => {
    const { server } = setup();
    // A server that takes DD.MM.YYYY, asked through a connection whose dates are garbled: it takes neither way.
    server.dateFormat = "dmy";
    server.defaultFrom = "2026-01-01";
    const strange = new DidoxClient(
      {
        baseUrl: "https://didox.test/",
        fetch: (input, init) =>
          server.fetch(String(input).replace(/(dateFrom|dateTo)=[^&]*/g, "$1=garbage"), init),
      },
      new FakeSigner(),
    );
    server.documents = [
      {
        id: "new",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2026-03-02 10:00:00",
        json: invoice("9", "2026-03-01", "1", "302936161"),
      },
    ];
    const result = await fetchDidoxDocuments(strange, {
      direction: "incoming",
      from: "2020-01-01",
      to: "2020-12-31",
      limit: 100,
      today: "2026-11-10",
    });
    expect(result.dateFilter).toBe(false);
    expect(explainEmpty(result, "2020-01-01", "2020-12-31")).toContain("did not take the date");
  });

  it("asks with both ends of a year when the list takes a period only that way", async () => {
    const { server, client } = setup();
    server.dateFormat = "dmy";
    server.needsBothDates = true;
    server.defaultFrom = "2026-01-01";
    server.documents = [
      {
        id: "new",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2026-03-02 10:00:00",
        json: invoice("9", "2026-03-01", "1", "302936161"),
      },
      {
        id: "old",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2020-04-13 10:00:00",
        json: invoice("1", "2020-04-12", "1", "302936161"),
      },
    ];
    const result = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2020-01-01",
      to: "2020-12-31",
      limit: 100,
      today: "2026-11-10",
    });
    expect(result.dateFilter).toBe(true);
    expect(result.documents.map((d) => d.number)).toEqual(["1"]);
  });

  it("finds a period under other query names", async () => {
    const { server, client } = setup();
    server.dateNames = ["fromDate", "toDate"];
    server.defaultFrom = "2026-01-01";
    server.documents = [
      {
        id: "new",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2026-03-02 10:00:00",
        json: invoice("9", "2026-03-01", "1", "302936161"),
      },
      {
        id: "old",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2020-04-13 10:00:00",
        json: invoice("1", "2020-04-12", "1", "302936161"),
      },
    ];
    const result = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2020-01-01",
      to: "2020-12-31",
      limit: 100,
      today: "2026-11-10",
    });
    expect(result.dateFilter).toBe(true);
    expect(result.documents).toHaveLength(1);
  });

  it("says what each way of asking gave and which fields the list carries when none works", async () => {
    const { server } = setup();
    server.dateNames = ["somethingElse", "another"];
    server.defaultFrom = "2026-01-01";
    server.documents = [
      {
        id: "new",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2026-03-02 10:00:00",
        json: invoice("9", "2026-03-01", "1", "302936161"),
      },
    ];
    const client = new DidoxClient({ baseUrl: "https://didox.test/", fetch: server.fetch }, new FakeSigner());
    const result = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2020-01-01",
      to: "2020-12-31",
      limit: 100,
      today: "2026-11-10",
    });
    expect(result.dateFilter).toBe(false);
    expect(result.dateProbe?.length).toBe(8);
    expect(result.dateProbe?.[0]).toContain("dateFrom/dateTo DD.MM.YYYY");
    expect(result.entryFields).toContain("id");
  });

  it("tells what the list gave by year, type and status, and what each window gave", async () => {
    const { server, client } = setup();
    server.dateFormat = "dmy";
    const entry = (id: string, date: string, doctype: string, status: number, updated: string) => ({
      id,
      doctype,
      status,
      owner: 1 as const,
      updated,
      docdate: date,
      json: invoice(id, date, "302936161", "1"),
    });
    server.documents = [
      entry("a", "2026-03-01", "002", 3, "2026-03-02 10:00:00"),
      entry("b", "2020-04-12", "002", 3, "2020-04-13 10:00:00"),
      entry("c", "2020-05-01", "005", 1, "2020-05-02 10:00:00"),
    ];
    const result = await fetchDidoxDocuments(client, {
      direction: "outgoing",
      from: "2020-01-01",
      to: "2020-12-31",
      limit: 100,
      today: "2026-11-10",
    });
    expect(result.audit?.seenByYear).toBe("2020:2, 2026:1");
    expect(result.audit?.byDoctype).toBe("002:2, 005:1");
    expect(result.audit?.byStatus).toBe("1:1, 3:2");
    expect(
      result.audit?.windows.some((w) => w.startsWith("out 2020-01-01..2020-12-30: 1 pages, 2 entries")),
    ).toBe(true);
  });

  it("cuts a period into windows of a year, newest first, up to today", () => {
    expect(windowsOf("2020-01-01", "2021-06-30")).toEqual([
      { from: "2020-12-31", to: "2021-06-30" },
      { from: "2020-01-01", to: "2020-12-30" }, // 2020 has 366 days
    ]);
    expect(windowsOf("2026-05-01", "2026-05-01")).toEqual([{ from: "2026-05-01", to: "2026-05-01" }]);
  });

  it("does not remember a date probe that failed, stops probing at it, and goes on without the date", async () => {
    let probes = 0;
    const client = {
      listDocuments: async (query: { dateFrom?: string }) => {
        if (query.dateFrom) {
          probes += 1;
          throw new Error("connection reset");
        }
        return { data: [] };
      },
    } as unknown as DidoxClient;
    const options = { direction: "incoming" as const, from: "2020-01-01", limit: 10, today: "2026-11-10" };
    const first = await fetchDidoxDocuments(client, options);
    expect(first.dateFilter).toBeUndefined();
    await fetchDidoxDocuments(client, options);
    expect(probes).toBe(2); // asked again, not taken as "Didox ignores dates"; and the probing stopped at the first failure
  });

  it("goes on to the next way only when a way was refused, not when Didox is in trouble", async () => {
    let probes = 0;
    const refuse = {
      listDocuments: async (query: Record<string, string>) => {
        if (Object.keys(query).some((key) => /from|start/i.test(key) && key !== "owner")) {
          probes += 1;
          throw new DidoxError("DIDOX_HTTP", "bad request", 400);
        }
        return { data: [] };
      },
    } as unknown as DidoxClient;
    const result = await fetchDidoxDocuments(refuse, {
      direction: "incoming",
      from: "2020-01-01",
      limit: 10,
      today: "2026-11-10",
    });
    expect(probes).toBe(8); // every way was tried, each refused at its first request
    expect(result.dateFilter).toBeUndefined();
    let limited = 0;
    const busy = {
      listDocuments: async (query: Record<string, string>) => {
        if (query.dateFrom) {
          limited += 1;
          throw new DidoxError("DIDOX_HTTP", "slow down", 429);
        }
        return { data: [] };
      },
    } as unknown as DidoxClient;
    await fetchDidoxDocuments(busy, {
      direction: "incoming",
      from: "2020-01-01",
      limit: 10,
      today: "2026-11-10",
    });
    expect(limited).toBe(1);
  });

  it("does not take a list that honours only one end of a period", async () => {
    const { server, client } = setup();
    server.dateFormat = "dmy";
    server.ignoresDateFrom = true;
    server.defaultFrom = "2026-01-01";
    server.documents = [
      {
        id: "new",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2026-03-02 10:00:00",
        json: invoice("9", "2026-03-01", "1", "302936161"),
      },
    ];
    const result = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2020-01-01",
      to: "2020-12-31",
      limit: 100,
      today: "2026-11-10",
    });
    expect(result.dateFilter).toBe(false);
  });

  it("finds the way with the outgoing list when the incoming one has nothing in the last year", async () => {
    const { server, client } = setup();
    server.dateFormat = "dmy";
    server.defaultFrom = "2026-01-01";
    server.documents = [
      {
        id: "out",
        doctype: "002",
        status: 3,
        owner: 1,
        updated: "2026-03-02 10:00:00",
        json: invoice("9", "2026-03-01", "302936161", "1"),
      },
      {
        id: "old",
        doctype: "002",
        status: 3,
        owner: 0,
        updated: "2020-04-13 10:00:00",
        json: invoice("1", "2020-04-12", "1", "302936161"),
      },
    ];
    const result = await fetchDidoxDocuments(client, {
      direction: "both",
      from: "2020-01-01",
      to: "2020-12-31",
      limit: 100,
      today: "2026-11-10",
    });
    expect(result.dateFilter).toBe(true);
    expect(result.documents.map((d) => d.number)).toEqual(["1"]);
  });

  it("reads the documents changed near the period first, so entries without their own date do not use up the limit", async () => {
    const { server, client } = setup();
    server.dateFormat = "dmy";
    // Newer entries come first and carry only the day they were changed; the one that is of 2020 comes last.
    server.documents = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `n${i}`,
        doctype: "002",
        status: 3,
        owner: 0 as const,
        updated: "2026-03-02 10:00:00",
        json: invoice(`n${i}`, "2026-03-01", "1", "302936161"),
      })),
      {
        id: "old",
        doctype: "002",
        status: 3,
        owner: 0 as const,
        updated: "2020-04-13 10:00:00",
        json: invoice("1", "2020-04-12", "1", "302936161"),
      },
    ];
    const result = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2020-01-01",
      to: "2020-12-31",
      limit: 3,
      today: "2026-11-10",
    });
    expect(result.documents.map((d) => d.number)).toEqual(["1"]);
    expect(result.truncated).toBe(true);
  });

  it("does not fail on a date that is not a real day", async () => {
    const { client } = setup();
    const result = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2020-13-45",
      limit: 10,
    });
    expect(result.dateFilter).toBeUndefined();
    expect(isDay("2020-02-30")).toBe(false);
    expect(isDay("2020-02-29")).toBe(true);
  });

  it("is not stopped by a page wholly older than the period when the date bounds the list", async () => {
    const { server, client } = setup();
    server.dateFormat = "dmy";
    server.pageCap = 2;
    const entry = (id: string, date: string, updated: string) => ({
      id,
      doctype: "002",
      status: 3,
      owner: 0 as const,
      updated,
      docdate: date,
      json: invoice(id, date, "1", "302936161"),
    });
    // The list is not in the order of the documents' own dates: old ones changed lately come first.
    server.documents = [
      entry("1", "2019-12-01", "2026-05-01 10:00:00"),
      entry("2", "2019-11-01", "2026-05-01 10:00:00"),
      entry("3", "2020-03-01", "2026-04-01 10:00:00"),
    ];
    const result = await fetchDidoxDocuments(client, {
      direction: "incoming",
      from: "2020-01-01",
      to: "2020-12-31",
      limit: 100,
      today: "2026-11-10",
    });
    expect(result.documents.map((d) => d.number)).toEqual(["3"]);
  });

  it("walks every page when Didox gives fewer entries than the limit asked", async () => {
    const { server, client } = setup();
    server.pageCap = 20;
    server.documents = Array.from({ length: 95 }, (_, i) => ({
      id: `d${i}`,
      doctype: "002",
      status: 3,
      owner: 0 as const,
      json: invoice(String(i + 1), "2020-05-01", "1", "302936161"),
    }));
    const result = await fetchDidoxDocuments(client, { direction: "incoming", limit: 300 });
    expect(result.documents).toHaveLength(95);
    expect(result.pagesRead).toBe(5);
  });

  it("does not mistake an error answer for an empty list", async () => {
    const client = {
      listDocuments: async () => ({ success: false, error: "token expired" }),
    } as unknown as DidoxClient;
    await expect(fetchDidoxDocuments(client, { direction: "incoming", limit: 10 })).rejects.toThrow(
      /token expired/,
    );
    const empty = { listDocuments: async () => ({ data: [] }) } as unknown as DidoxClient;
    const result = await fetchDidoxDocuments(empty, { direction: "incoming", limit: 10 });
    expect(result.pagesRead).toBe(0);
  });

  it("counts a document with no date as unreadable and keeps the listed range to real document dates", async () => {
    const { server, client } = setup();
    server.documents = [
      { id: "a", doctype: "002", status: 3, owner: 0, json: invoice("1", "2026-10-09", "1", "302936161") },
      { id: "b", doctype: "002", status: 3, owner: 0, json: invoice("2", "", "1", "302936161") },
    ];
    const result = await fetchDidoxDocuments(client, { direction: "incoming", limit: 10 });
    expect(result.seen).toBe(2);
    expect(result.documents).toHaveLength(1);
    expect(result.unreadable).toBe(1);
  });

  it("only says the list ends at a date when it was read to its end", () => {
    const base = {
      documents: [],
      listed: 0,
      seen: 100,
      skipped: 0,
      unreadable: 0,
      outsidePeriod: 0,
      newerThanPeriod: 0,
      oldestListed: "2024-05-01",
      newestListed: "2026-01-01",
      pagesRead: 1,
      stoppedAtPageLimit: false,
      failed: [],
      truncated: true,
    };
    expect(explainEmpty(base, "2020-01-01", "2023-12-31")).not.toContain("goes back only");
    expect(explainEmpty({ ...base, truncated: false }, "2020-01-01", "2023-12-31")).toContain(
      "goes back only to 2024-05-01",
    );
    const deep = { ...base, truncated: false, stoppedAtPageLimit: true, documents: [{}] as never[] };
    expect(partialNote(deep, "2020-01-01")).toContain("stopped at the most pages");
    expect(partialNote({ ...deep, stoppedAtPageLimit: false }, "2020-01-01")).toBe("");
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
