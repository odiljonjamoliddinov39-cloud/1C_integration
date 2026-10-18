import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { DidoxClient, DidoxError } from "./client.js";
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
  it("signs in with the key: authId for its serial number, the authId signed, the token kept", async () => {
    const { server, signer, client } = setup();
    await client.login();
    expect(client.signedIn).toBe(true);
    expect(server.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "GET /v1/auth/authId/5A3C0F",
      "POST /v1/dsvs/gettimestamp",
      "POST /v1/auth/login",
    ]);
    expect(signer.signed).toEqual([JSON.stringify({ authId: "auth-5A3C0F" })]);
    // The signature value goes to Didox for its time stamp; the PKCS#7 that comes back carries it.
    const signed = Buffer.from(`PKCS7:${JSON.stringify({ authId: "auth-5A3C0F" })}`).toString("base64");
    const hex = Buffer.from(JSON.stringify({ authId: "auth-5A3C0F" })).toString("hex");
    expect(server.requests[1]?.body).toMatchObject({ signature: hex });
    const token = Buffer.from(`TST(${hex})`).toString("base64");
    expect(server.requests[2]?.body).toEqual({
      serialNumber: "5A3C0F",
      pkcs7: Buffer.from(`TS:${token}:${signed}`).toString("base64"),
    });
    // The sign-in itself carries no token.
    expect(server.requests[0]?.headers["user-key"]).toBeUndefined();
    expect(server.requests[0]?.headers["api-key"]).toBe("partner-key");
  });

  it.each(["signature-text", "pkcs7-json", "pkcs7-text"] as const)(
    "finds the shape the time stamp endpoint takes (%s) by trying the likely ones",
    async (takes) => {
      const { server, client } = setup();
      server.timestampTakes = takes;
      await client.login();
      expect(client.signedIn).toBe(true);
    },
  );

  it("shows what the time stamp endpoint answered when no shape gets a token", async () => {
    const { server } = setup();
    const refusing = new DidoxClient(
      {
        baseUrl: "https://didox.test/",
        fetch: async (input, init) =>
          String(input).includes("gettimestamp")
            ? new Response('{"success":true,"timeStampTokenB64":"","isAttachedPkcs7":false}')
            : server.fetch(input, init),
      },
      new FakeSigner(),
    );
    const error = await refusing.login().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DidoxError);
    expect((error as DidoxError).message).toContain("no time stamp token");
    expect((error as DidoxError).message).toContain(
      'the PKCS#7 as text: {"success":true,"timeStampTokenB64":""',
    );
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
    expect(server.requests.filter((r) => r.url.pathname === "/v1/auth/login")).toHaveLength(2);
  });

  it("downloads a document's archive from the link, without sending our keys to the link", async () => {
    const { server, client } = setup();
    server.archives.set("doc-1", new Uint8Array([0x50, 0x4b, 3, 4]));
    const bytes = await client.downloadArchive("doc-1");
    expect([...bytes]).toEqual([0x50, 0x4b, 3, 4]);
    const file = server.requests.at(-1);
    expect(file?.url.host).toBe("files.didox.test");
    expect(file?.headers["user-key"]).toBeUndefined();
    expect(file?.headers["api-key"]).toBeUndefined();
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
          String(input).includes("gettimestamp")
            ? new Response(JSON.stringify({ success: true, timeStampTokenB64: answer }))
            : (login ?? new Response("{}")),
      });

    it("takes a token that stamps this signature, and unwraps a TimeStampResp", async () => {
      expect(await answering(token).timestampToken({ pkcs7: "", signatureHex: stamped })).toBe(token);
      expect(await answering(response).timestampToken({ pkcs7: "", signatureHex: stamped })).toBe(token);
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
            String(input).includes("gettimestamp")
              ? new Response(JSON.stringify({ success: true, timeStampTokenB64: token }))
              : String(input).includes("/auth/login")
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
        /\[time stamp from the signature as JSON: .*sha256 imprint/,
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
      expect((error as DidoxError).message).toContain("this Didox has no /v1/dsvs/gettimestamp");
    });
  });
});
