import { describe, expect, it } from "vitest";

import { DidoxClient } from "./client.js";
import { createDraft, prepareDraft } from "./draft.js";
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

  it("says that Didox does not know the buyer", async () => {
    const { client } = setup();
    const prepared = await prepareDraft(client, { ...input, buyerTin: "999999999" }, "302936161");
    expect(prepared).toMatchObject({ ok: false, problems: [{ code: "NO_PARTY" }] });
  });
});
