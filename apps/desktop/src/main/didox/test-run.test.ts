import { describe, expect, it } from "vitest";

import { EImzoClient } from "./eimzo.js";
import { FakeEImzo } from "./fake-eimzo.js";
import { FakeDidox } from "./fake.js";
import { firstDocumentId, runDidoxTest } from "./test-run.js";

const ALIAS =
  "1.2.860.3.16.1.1=302936161,CN=ИВАНОВ ИВАН,O=FIDES PROJECTS XK,SERIALNUMBER=5A3C0F11,VALIDFROM=2025.01.01 00:00:00,VALIDTO=2099.01.01 23:59:59";

/** A zip with one text file, stored. */
function tinyZip(name: string, text: string): Uint8Array {
  const data = Buffer.from(text);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt32LE(data.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(n.length, 28);
  const central = Buffer.concat([entry, n]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(30 + n.length + data.length, 16);
  return new Uint8Array(Buffer.concat([local, n, data, central, end]));
}

function setup() {
  const eimzo = new FakeEImzo();
  eimzo.certificates = [{ disk: "D", path: "/k", name: "key1", alias: ALIAS }];
  const didox = new FakeDidox();
  didox.documents = [{ id: "doc-1", doctype: "001", status: 2, owner: 0 }];
  didox.archives.set("doc-1", tinyZip("invoice.xml", "<Invoice/>"));
  return {
    eimzo,
    didox,
    run: (input = {}) =>
      runDidoxTest(input, { eimzo: new EImzoClient({ connect: eimzo.connect }), fetch: didox.fetch }),
  };
}

describe("Didox test run", () => {
  it("goes through every step: E-IMZO, the key, sign-in, profile, documents and one archive", async () => {
    const { run } = setup();
    const result = await run({ baseUrl: "https://didox.test/" });
    expect(result.steps.map((s) => `${s.name}:${s.ok}`)).toEqual([
      "eimzo:true",
      "keys:true",
      "login:true",
      "profile:false", // the fake has no profile endpoint: a step that fails does not stop the others
      "documents:true",
      "archive:true",
    ]);
    expect(result.steps[1]?.detail).toContain("5A3C0F11 · INN 302936161");
    const archive = result.steps.at(-1);
    expect(archive?.detail).toContain("Document doc-1");
    expect(archive?.detail).toContain("invoice.xml");
  });

  it("stops at the first step that cannot go on, and says which", async () => {
    const { eimzo, run } = setup();
    eimzo.down = true;
    const down = await run();
    expect(down.steps).toEqual([
      { name: "eimzo", ok: false, detail: expect.stringContaining("EIMZO_UNAVAILABLE") },
    ]);

    eimzo.down = false;
    eimzo.certificates = [];
    const none = await run();
    expect(none.steps.map((s) => `${s.name}:${s.ok}`)).toEqual(["eimzo:true", "keys:false"]);
  });

  it("uses the development server by default", async () => {
    const { run } = setup();
    expect((await run()).baseUrl).toBe("https://devapi.goodsign.biz/");
  });

  it("finds a document id in the shapes a list may come in", () => {
    expect(firstDocumentId([{ id: "a" }])).toBe("a");
    expect(firstDocumentId({ data: [{ documentId: 7 }] })).toBe("7");
    expect(firstDocumentId({ items: [] })).toBeNull();
    expect(firstDocumentId("nothing")).toBeNull();
  });
});
