import { describe, expect, it } from "vitest";

import { DidoxClient } from "./client.js";
import { DOCUMENT_DOCTYPE, createDraft, prepareDocumentDraft, prepareDraft } from "./draft.js";
import { FakeDidox, FakeSigner } from "./fake.js";

function setup() {
  const server = new FakeDidox();
  server.profiles.set("201607534", { name: "NAVRO'Z-PTK MCHJ", account: "2020", mfo: "00014" });
  const client = new DidoxClient({ baseUrl: "https://didox.test/", fetch: server.fetch }, new FakeSigner());
  return { server, client };
}

const input = {
  number: "1294",
  date: "2026-10-19",
  buyerTin: "201607534",
  lines: [{ name: "Suv", unit: "шт", qty: 2, price: 1000, vatRate: 12 }],
};

describe("invoice draft in Didox", () => {
  it("is built from Didox's profiles and units, then created as a draft only", async () => {
    const { server, client } = setup();
    const prepared = await prepareDraft(client, input, "302936161");
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    expect(prepared.preview.seller).toEqual({ tin: "302936161", name: "OWN MCHJ" });
    expect(prepared.preview.buyer.name).toBe("NAVRO'Z-PTK MCHJ");
    expect(prepared.preview.totals.total).toBe("2240.00");
    expect(server.drafts).toHaveLength(0);

    const id = await createDraft(client, prepared.body);
    expect(id).toBe("DRAFT1");
    expect(server.drafts).toHaveLength(1);
    expect(server.drafts[0]?.docType).toBe("002");
    // Only the creation was asked of Didox: nothing was signed, accepted or sent.
    expect(server.requests.map((r) => r.url.pathname).filter((p) => /sign|send|accept/.test(p))).toEqual([]);
  });

  it("takes a unit from the company's own documents when Didox's list does not give it by that name", async () => {
    const { server, client } = setup();
    // A list of units this app cannot read a name from.
    server.measures = [{ id: "9", name: "" }];
    const today = new Date().toISOString().slice(0, 10);
    server.documents = [
      {
        id: "o1",
        doctype: "002",
        status: 3,
        owner: 1,
        updated: `${today} 10:00:00`,
        json: {
          facturadoc: { facturano: "1", facturadate: today },
          sellertin: "302936161",
          seller: { name: "OWN MCHJ" },
          buyertin: "201607534",
          buyer: { name: "NAVRO'Z-PTK MCHJ" },
          productlist: {
            hasvat: false,
            products: [
              {
                ordno: 1,
                name: "Suv",
                count: "1",
                summa: "1000.00",
                deliverysum: "1000.00",
                vatrate: 0,
                vatsum: 0,
                deliverysumwithvat: "1000.00",
                packagename: "dona (paket)",
                packagecode: "1234567",
              },
            ],
          },
        },
      },
    ];
    const prepared = await prepareDraft(client, input, "302936161");
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    const products = (prepared.body as { ProductList: { Products: { MeasureId: string }[] } }).ProductList
      .Products;
    expect(products[0]?.MeasureId).toBe("1234567");
  });

  it("says that Didox does not know the buyer", async () => {
    const { client } = setup();
    const prepared = await prepareDraft(client, { ...input, buyerTin: "999999999" }, "302936161");
    expect(prepared).toMatchObject({ ok: false, problems: [{ code: "NO_PARTY" }] });
  });
});

describe("letter draft in Didox", () => {
  const letter = {
    type: "letter" as const,
    number: "15",
    date: "2026-10-19",
    buyerTin: "201607534",
    subject: "Akt sverka haqida",
    text: "Hurmatli hamkor!\n\nSizdan <solishtirma> dalolatnomani imzolashni so'raymiz.",
  };

  it("puts the text into a PDF, and creates a free-form draft (000) only when asked", async () => {
    const { server, client } = setup();
    const pages: string[] = [];
    const render = async (html: string) => {
      pages.push(html);
      return new Uint8Array(Buffer.from("%PDF-test"));
    };
    const prepared = await prepareDocumentDraft(client, letter, "302936161", render);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    expect(pages[0]).toContain("&lt;solishtirma&gt;");
    expect(pages[0]).toContain("NAVRO'Z-PTK MCHJ");
    expect(prepared.preview).toMatchObject({
      type: "letter",
      number: "15",
      buyer: { name: "NAVRO'Z-PTK MCHJ" },
    });
    expect(server.drafts).toHaveLength(0);

    await createDraft(client, prepared.body, DOCUMENT_DOCTYPE);
    expect(server.drafts[0]?.docType).toBe("000");
    expect((server.drafts[0]?.body as { document: string }).document).toBe(
      Buffer.from("%PDF-test").toString("base64"),
    );
  });

  it("makes no PDF for a recipient Didox does not know", async () => {
    const { client } = setup();
    let rendered = false;
    const prepared = await prepareDocumentDraft(
      client,
      { ...letter, buyerTin: "999999999" },
      "302936161",
      async () => {
        rendered = true;
        return new Uint8Array();
      },
    );
    expect(prepared).toMatchObject({ ok: false, problems: [{ code: "NO_PARTY" }] });
    expect(rendered).toBe(false);
  });
});
