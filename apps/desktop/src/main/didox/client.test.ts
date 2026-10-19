import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { DidoxClient, DidoxError, didoxServer } from "./client.js";
import { FakeDidox, FakeSigner } from "./fake.js";

function setup() {
  const server = new FakeDidox();
  const signer = new FakeSigner();
  const client = new DidoxClient(
    { baseUrl: "https://didox.test/", apiKey: "partner-key", fetch: server.fetch },
    signer,
  );
  return { server, signer, client };
}

describe("DidoxClient", () => {
  it("signs in with the key: authId, the signature time-stamped by Didox, then /v1/auth/{taxId}/token", async () => {
    const { server, signer, client } = setup();
    await client.login();
    expect(client.signedIn).toBe(true);
    expect(server.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "GET /v1/auth/authId/5A3C0F",
      "POST /v1/dsvs/timestamp",
      "POST /v1/auth/302936161/token",
    ]);
    expect(signer.signed).toEqual([JSON.stringify({ authId: "auth-5A3C0F" })]);
    // Didox's time stamp service gets the PKCS#7 and the signature value, both.
    const signed = Buffer.from(`PKCS7:${JSON.stringify({ authId: "auth-5A3C0F" })}`).toString("base64");
    const hex = Buffer.from(JSON.stringify({ authId: "auth-5A3C0F" })).toString("hex");
    expect(server.requests[1]?.body).toEqual({ pkcs7: signed, signatureHex: hex });
    // The sign-in carries the stamped signature as `signature`.
    const token = Buffer.from(`TST(${hex})`).toString("base64");
    expect(server.requests[2]?.body).toEqual({
      serialNumber: "5A3C0F",
      signature: Buffer.from(`TS:${token}:${signed}`).toString("base64"),
    });
    // The sign-in itself carries no token.
    expect(server.requests[0]?.headers["user-key"]).toBeUndefined();
  });

  it("uses the PKCS#7 Didox has put the time stamp into (isAttachedPkcs7) as it is", async () => {
    const { server, client } = setup();
    server.attachesStamp = true;
    await client.login();
    expect(client.signedIn).toBe(true);
  });

  it("goes to the older /v1/auth/login where /v1/auth/{taxId}/token is not", async () => {
    const { server, client } = setup();
    server.hasPersonLogin = false;
    await client.login();
    expect(client.signedIn).toBe(true);
    expect(server.requests.at(-1)?.url.pathname).toBe("/v1/auth/login");
    expect(server.requests.at(-1)?.body).toMatchObject({ serialNumber: "5A3C0F" });
  });

  it("asks for the company's token when the key is a person's and a company is to be worked for", async () => {
    const server = new FakeDidox();
    const client = new DidoxClient(
      { baseUrl: "https://didox.test/", companyTin: "303212825", fetch: server.fetch },
      new FakeSigner("5A3C0F", "30101900000001"),
    );
    await client.listDocuments();
    expect(server.companyTokens).toEqual(["303212825"]);
    // The company's token (the second one issued) is what the requests carry.
    expect(server.requests.at(-1)?.headers["user-key"]).toBe("token-2");
    // A company's own key needs no exchange.
    const own = new FakeDidox();
    await new DidoxClient(
      { baseUrl: "https://didox.test/", companyTin: "302936161", fetch: own.fetch },
      new FakeSigner(),
    ).listDocuments();
    expect(own.companyTokens).toEqual([]);
  });

  it("signs in by itself on the first request, and lists documents with the filters as query", async () => {
    const { server, client } = setup();
    server.documents = [
      { id: "a", doctype: "001", status: 2, owner: 0 },
      { id: "b", doctype: "005", status: 3, owner: 0 },
      { id: "c", doctype: "001", status: 1, owner: 1 },
    ];
    const list = await client.listDocuments({
      owner: 0,
      doctype: "001,002",
      limit: 5,
      dateFrom: "2026-10-01",
    });
    expect(list).toEqual([{ id: "a", doctype: "001", status: 2, owner: 0 }]);
    const request = server.requests.at(-1);
    expect(request?.url.search).toBe("?owner=0&doctype=001%2C002&limit=5&dateFrom=2026-10-01");
    expect(request?.headers["user-key"]).toBe("token-1");
  });

  it("renews a token that lapsed early, once, and goes on", async () => {
    const { server, client } = setup();
    server.documents = [{ id: "a", doctype: "001", status: 2, owner: 0 }];
    await client.listDocuments();
    server.expireTokens();
    await expect(client.listDocuments()).resolves.toHaveLength(1);
    expect(server.requests.filter((r) => /^\/v1\/auth\/\d+\/token$/.test(r.url.pathname))).toHaveLength(2);
  });

  it("reads a document's print form from the base64 Didox answers with", async () => {
    const { server, client } = setup();
    server.files.set("doc-1", new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const bytes = await client.documentFile("doc-1");
    expect([...bytes]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(server.requests.at(-1)?.url.pathname).toBe("/v1/documents/doc-1/file/true");
    await expect(client.documentFile("nope")).rejects.toMatchObject({ code: "DIDOX_HTTP", status: 404 });
  });

  it("deletes a draft, with the method the server has a route for", async () => {
    const { server, client } = setup();
    server.drafts.push({ docType: "000", body: {} });
    await client.deleteDraft("DRAFT1");
    expect(server.drafts).toHaveLength(0);
    expect(server.requests.at(-1)).toMatchObject({ method: "POST" });

    server.deleteMethods = ["DELETE"];
    server.drafts.push({ docType: "000", body: {} });
    await client.deleteDraft("DRAFT1");
    expect(server.drafts).toHaveLength(0);
    expect(server.requests.map((r) => r.method).slice(-2)).toEqual(["POST", "DELETE"]);
    await expect(client.deleteDraft("DRAFT9")).rejects.toMatchObject({ status: 404 });
  });

  it("says what failed, in codes", async () => {
    const { client } = setup();
    await expect(client.documentInfo("missing")).rejects.toMatchObject({ code: "DIDOX_HTTP", status: 404 });
    const noKey = new DidoxClient({ fetch: new FakeDidox().fetch });
    await expect(noKey.profile()).rejects.toMatchObject({ code: "DIDOX_AUTH" });
    const offline = new DidoxClient({
      fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    });
    offline.setToken("t", Date.now() + 3_600_000);
    const error = await offline.profile().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DidoxError);
    expect(error).toMatchObject({ code: "DIDOX_NETWORK" });
  });

  describe("the time stamp token", () => {
    const token = readFileSync(new URL("./fixtures/cms-timestamp-token.b64", import.meta.url), "utf8").trim();
    const response = readFileSync(
      new URL("./fixtures/cms-timestamp-response.b64", import.meta.url),
      "utf8",
    ).trim();
    // The token stamps {"authId":"abc"}.
    const stamped = Buffer.from('{"authId":"abc"}').toString("hex");
    const answering = (answer: string, login?: Response) =>
      new DidoxClient({
        baseUrl: "https://didox.test/",
        fetch: async (input) =>
          String(input).includes("dsvs/")
            ? new Response(JSON.stringify({ success: true, timeStampTokenB64: answer }))
            : (login ?? new Response("{}")),
      });

    it("takes a token that stamps this signature, and unwraps a TimeStampResp", async () => {
      expect(await answering(token).timestampToken({ pkcs7: "", signatureHex: stamped })).toEqual({
        value: token,
        attached: false,
      });
      expect(await answering(response).timestampToken({ pkcs7: "", signatureHex: stamped })).toEqual({
        value: token,
        attached: false,
      });
    });

    it("does not take a token for other data, and shows what it is", async () => {
      const error = await answering(token)
        .timestampToken({ pkcs7: "", signatureHex: "00ff" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DidoxError);
      expect((error as DidoxError).message).toContain("a token for other data");
      expect((error as DidoxError).message).toContain("sha256 imprint");
    });

    it("says how the signature was stamped when Didox still refuses the sign-in", async () => {
      const server = new FakeDidox();
      const client = new DidoxClient(
        {
          baseUrl: "https://didox.test/",
          fetch: async (input, init) =>
            String(input).includes("dsvs/")
              ? new Response(JSON.stringify({ success: true, timeStampTokenB64: token }))
              : String(input).includes("/token")
                ? new Response('{"error":"timestamp is required"}', { status: 401 })
                : server.fetch(input, init),
        },
        {
          serialNumber: async () => "5A3C0F",
          pkcs7: async (_data, stamp) => {
            await stamp?.({ pkcs7: "", signatureHex: stamped });
            return "pkcs7";
          },
        },
      );
      const error = await client.login().catch((e: unknown) => e);
      expect((error as DidoxError).message).toContain("timestamp is required");
      expect((error as DidoxError).message).toMatch(
        /\[time stamp from \/v1\/dsvs\/timestamp: .*sha256 imprint/,
      );
    });
  });

  describe("a Didox with no time stamp service", () => {
    it("signs without a time stamp and signs in, when the sign-in does not ask for one", async () => {
      const { server, signer, client } = setup();
      server.hasTimestampEndpoint = false;
      server.requiresTimestamp = false;
      await client.login();
      expect(client.signedIn).toBe(true);
      // Signed twice: with a stamp tried first, then without.
      expect(signer.signed).toHaveLength(2);
    });

    it("says so when the sign-in then asks for a time stamp after all", async () => {
      const { server, client } = setup();
      server.hasTimestampEndpoint = false;
      const error = await client.login().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DidoxError);
      expect((error as DidoxError).message).toContain("timestamp is required");
      expect((error as DidoxError).message).toContain("this Didox has no /v1/dsvs/timestamp");
    });
  });

  it("sends the token as both api-key and user-key after sign-in, and a partner key only before it", async () => {
    const { server, client } = setup();
    await client.listDocuments();
    // Before sign-in only the partner key (if one was given) travels as api-key.
    expect(server.requests[0]?.headers["api-key"]).toBe("partner-key");
    expect(server.requests[0]?.headers["user-key"]).toBeUndefined();
    // After it, the token is both, as Didox's own 1C library sends it.
    const last = server.requests.at(-1);
    expect(last?.headers["user-key"]).toBe("token-1");
    expect(last?.headers["api-key"]).toBe("token-1");
    const bare = new FakeDidox();
    await new DidoxClient(
      { baseUrl: "https://didox.test/", fetch: bare.fetch },
      new FakeSigner(),
    ).listDocuments();
    expect(bare.requests[0]?.headers["api-key"]).toBeUndefined();
  });

  it("cuts a pasted page URL to its server, and takes the site for the API (didox.uz is api.didox.uz)", () => {
    expect(didoxServer("")).toBe("https://testapi2.didox.uz");
    expect(didoxServer("https://didox.uz/documents/new?tab=all&p=1")).toBe("https://api.didox.uz");
    expect(didoxServer("didox.uz")).toBe("https://api.didox.uz");
    expect(didoxServer("https://api.didox.uz/")).toBe("https://api.didox.uz");
    expect(didoxServer("https://didox.test/v1/x")).toBe("https://didox.test");
  });

  it("says plainly that the address is the site's when Didox answers a web page", async () => {
    const page = "<!doctype html><html><head><title>Didox</title></head></html>";
    const client = new DidoxClient(
      { baseUrl: "https://didox.example/documents/new", fetch: async () => new Response(page) },
      new FakeSigner(),
    );
    const error = await client.login().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DidoxError);
    expect((error as DidoxError).message).toContain("a web page, not the API");
    expect((error as DidoxError).message).toContain("with no page path");
    // A 405 from the web server counts as that too, and still reads as "no time stamp service" where that matters.
    const refused = new DidoxClient(
      { baseUrl: "https://didox.example/", fetch: async () => new Response(page, { status: 405 }) },
      new FakeSigner(),
    );
    await expect(refused.listDocuments()).rejects.toThrow(/answered 405 with a web page/);
  });
});
