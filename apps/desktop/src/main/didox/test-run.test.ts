import { describe, expect, it } from "vitest";

import { EImzoClient } from "./eimzo.js";
import { FakeEImzo } from "./fake-eimzo.js";
import { FakeDidox } from "./fake.js";
import { firstDocumentId, runDidoxTest } from "./test-run.js";

const ALIAS =
  "1.2.860.3.16.1.1=302936161,CN=ИВАНОВ ИВАН,O=FIDES PROJECTS XK,SERIALNUMBER=5A3C0F11,VALIDFROM=2025.01.01 00:00:00,VALIDTO=2099.01.01 23:59:59";

function setup() {
  const eimzo = new FakeEImzo();
  eimzo.certificates = [{ disk: "D", path: "/k", name: "key1", alias: ALIAS }];
  const didox = new FakeDidox();
  didox.documents = [{ id: "doc-1", doctype: "001", status: 2, owner: 0 }];
  didox.files.set("doc-1", new Uint8Array(Buffer.from("%PDF-1.4")));
  return {
    eimzo,
    didox,
    run: (input = {}) =>
      runDidoxTest(input, { eimzo: new EImzoClient({ connect: eimzo.connect }), fetch: didox.fetch }),
  };
}

describe("Didox test run", () => {
  it("goes through every step: E-IMZO, the key, sign-in, profile, documents, one document and its print form", async () => {
    const { run } = setup();
    const result = await run({ baseUrl: "https://didox.test/" });
    expect(result.steps.map((s) => `${s.name}:${s.ok}`)).toEqual([
      "eimzo:true",
      "keys:true",
      "login:true",
      "profile:false", // the fake has no profile endpoint: a step that fails does not stop the others
      "documents:true",
      "document:true",
      "file:true",
    ]);
    expect(result.steps[1]?.detail).toContain("5A3C0F11 · INN 302936161");
    expect(result.steps.at(-2)?.detail).toContain("Document doc-1");
    expect(result.steps.at(-1)?.detail).toContain("a PDF");
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
    expect((await run()).baseUrl).toBe("https://testapi2.didox.uz/");
  });

  it("finds a document id in the shapes a list may come in", () => {
    expect(firstDocumentId([{ id: "a" }])).toBe("a");
    expect(firstDocumentId({ data: [{ documentId: 7 }] })).toBe("7");
    expect(firstDocumentId({ items: [] })).toBeNull();
    expect(firstDocumentId("nothing")).toBeNull();
  });
});
